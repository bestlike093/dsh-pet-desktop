// P5 冒烟：Vault 文件格式、加密存储与同步合并
import {
  AesGcmProvider,
  DEFAULT_KDF_ITERATIONS,
  MemoryVaultStorage,
  SyncEngine,
  VaultStore,
  canonicalAad,
  fromBase64,
  openVaultFile,
  parseVaultFile,
  sealVaultFile,
  serializeVaultFile
} from '../packages/vault/dist/index.js'
import { formatHlc } from '../packages/shared/dist/index.js'

let failed = 0
function check(name, ok, extra = '') {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : ''))
  if (!ok) failed += 1
}

const provider = new AesGcmProvider()
const password = '示例口令-2026'
const salt = new Uint8Array(16).fill(7)
const key = await provider.deriveKey(password, salt)
const plaintext = new TextEncoder().encode(JSON.stringify({ nickname: '小鹿', level: 3 }))

// 1. 文件格式
const file = await sealVaultFile(provider, key, plaintext, {
  salt,
  iterations: DEFAULT_KDF_ITERATIONS,
  updatedAt: 1_700_000_000_000
})
check('format: magic 与版本', file.magic === 'DSHPET1' && file.version === 1)
check(
  'format: AAD 覆盖头部',
  file.aad ===
    canonicalAad({
      suite: file.suite,
      kdf: file.kdf,
      updatedAt: file.updatedAt
    })
)
check('format: 盐沿用入参', file.kdf.salt === Buffer.from(salt).toString('base64'))

const parsed = parseVaultFile(serializeVaultFile(file))
check('format: 序列化往返', parsed.updatedAt === file.updatedAt && parsed.ciphertext === file.ciphertext)

const opened = await openVaultFile(provider, key, parsed)
check('format: 解密回原文', new TextDecoder().decode(opened) === JSON.stringify({ nickname: '小鹿', level: 3 }))

function expectCode(fn, code) {
  try {
    fn()
    return false
  } catch (error) {
    return error.code === code
  }
}
async function expectCodeAsync(fn, code) {
  try {
    await fn()
    return false
  } catch (error) {
    return error.code === code
  }
}

check('format: 拒绝错误 magic', expectCode(() => parseVaultFile({ ...file, magic: 'EVIL' }), 'VAULT_TAMPERED'))
check('format: 拒绝未来版本', expectCode(() => parseVaultFile({ ...file, version: 99 }), 'VAULT_TAMPERED'))
check(
  'format: 拒绝坏 JSON',
  expectCode(() => parseVaultFile('{not json'), 'VAULT_TAMPERED')
)
check(
  'format: 密文篡改被检出',
  await expectCodeAsync(() => openVaultFile(provider, key, { ...file, ciphertext: file.ciphertext.slice(0, -4) + 'AAAA' }), 'VAULT_TAMPERED')
)
check(
  'format: 头部时间篡改被检出',
  await expectCodeAsync(() => openVaultFile(provider, key, { ...file, updatedAt: file.updatedAt + 1 }), 'VAULT_TAMPERED')
)
check(
  'format: 套件不匹配被拒',
  await expectCodeAsync(() => openVaultFile(provider, key, { ...file, suite: 'other-suite' }), 'CRYPTO_SUITE_UNSUPPORTED')
)

// 2. 加密存储
const storage = new MemoryVaultStorage()
const store = new VaultStore(storage, {
  provider,
  now: () => 1_700_000_000_000,
  iterations: DEFAULT_KDF_ITERATIONS
})
check('store: 初始锁定', store.isLocked === true)
check('store: 未解锁不能保存', await expectCodeAsync(() => store.save({ a: 1 }), 'VAULT_LOCKED'))
check('store: 未解锁不能读取', await expectCodeAsync(() => store.load(), 'VAULT_LOCKED'))
check('store: 空口令被拒', await expectCodeAsync(() => store.unlock(''), 'INVALID_ARGUMENT'))

await store.unlock(password)
check('store: 解锁成功', store.isLocked === false)
await store.save({ nickname: '小鹿', tasks: [1, 2, 3] })
check('store: 落盘为密文', storage.raw() !== null && !storage.raw().includes('小鹿'))
check('store: 读回一致', (await store.load()).tasks.length === 3)

store.lock()
check('store: 锁定后不可读', await expectCodeAsync(() => store.load(), 'VAULT_LOCKED'))

const reopened = new VaultStore(storage, { provider, now: () => 1_700_000_000_000 })
await reopened.unlock(password)
check('store: 重新解锁沿用文件盐', (await reopened.load()).nickname === '小鹿')
check(
  'store: 错误口令被拒',
  await expectCodeAsync(() => new VaultStore(storage, { provider }).unlock('wrong-password'), 'INVALID_ARGUMENT')
)

const beforeTamper = storage.raw()
const tampered = JSON.parse(beforeTamper)
tampered.ciphertext = tampered.ciphertext.slice(0, -4) + 'AAAA'
storage.tamper(JSON.stringify(tampered))
check('store: 读取时检出篡改', await expectCodeAsync(() => reopened.load(), 'VAULT_TAMPERED'))
storage.tamper(beforeTamper)
check('store: 恢复后仍可读', (await reopened.load()).nickname === '小鹿')

check(
  'store: 内存存储原子写',
  typeof storage.writeAtomic === 'function' &&
    (await (async () => {
      await storage.writeAtomic('x')
      return storage.raw() === 'x'
    })())
)

// 3. 同步合并
const fixedNow = 1_700_000_000_000
const engineA = new SyncEngine({ node: 'A' })
const engineB = new SyncEngine({ node: 'B' })

const first = engineA.put('nickname', '小鹿')
check('sync: put 返回记录', first.key === 'nickname' && first.value === '小鹿')
check('sync: since 全量', engineA.since().records.length === 1)

const mergedB = engineB.merge(engineA.since())
check('sync: 首次合并无冲突', mergedB.conflicts.length === 0 && engineB.get('nickname').value === '小鹿')

engineA.put('level', 3)
const replay = engineB.merge(engineA.since())
check('sync: 同值重放幂等', replay.conflicts.length === 0 && engineB.get('level').value === 3)

const updated = engineB.put('nickname', '小岚')
check('sync: 本端更新生成更大 HLC', updated.hlc > first.hlc)
const mergedA = engineA.merge(engineB.since())
const nicknameConflict = mergedA.conflicts.find((item) => item.key === 'nickname')
check(
  'sync: LWW 远端胜出并记录冲突',
  engineA.get('nickname').value === '小岚' && nicknameConflict.winner === 'remote'
)
check(
  'sync: 冲突保留双方时间戳',
  nicknameConflict.localHlc === first.hlc && nicknameConflict.remoteHlc === updated.hlc
)

const staleHlc = formatHlc({ wall: Date.now() - 3_600_000, counter: 0, node: 'stale' })
check(
  'sync: 过期时间戳整批拒绝',
  await expectCodeAsync(
    async () =>
      engineA.merge({
        node: 'stale',
        records: [{ key: 'nickname', value: '旧包', hlc: staleHlc }]
      }),
    'TIMESTAMP_EXPIRED'
  )
)
check('sync: 拒绝后本地不变', engineA.get('nickname').value === '小岚')
check(
  'sync: 非法节点名被拒',
  await expectCodeAsync(async () => engineA.merge({ node: '', records: [] }), 'INVALID_ARGUMENT')
)

const ordered = new SyncEngine({ node: 'C' })
ordered.put('z', 1)
ordered.put('a', 2)
ordered.put('m', 3)
check(
  'sync: snapshot 按 key 稳定排序',
  ordered.snapshot().map((item) => item.key).join(',') === 'a,m,z'
)
check('sync: 增量按 since 过滤', ordered.since(ordered.get('a').hlc).records.every((item) => item.key !== 'a'))
check(
  'sync: 合并结果确定性',
  JSON.stringify(engineA.merge(engineB.since()).records) ===
    JSON.stringify(engineA.merge(engineB.since()).records)
)

// 4. 盐解码
const decodedSalt = fromBase64(file.kdf.salt)
check('format: 盐可还原', decodedSalt.length === 16 && decodedSalt[0] === 7)

console.log('\nP5_SMOKE_' + (failed === 0 ? 'OK' : 'FAILED_' + failed))
process.exit(failed === 0 ? 0 : 1)
