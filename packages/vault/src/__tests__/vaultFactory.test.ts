import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ErrorCode } from '@pet/shared'
import { createFileKeyRing } from '../crypto/fileKeyRing.js'
import { createMemoryBackend, type SafeStorageLike } from '../crypto/keyBackend.js'
import { AesGcmProvider } from '../crypto/provider.js'
import { createAuditLog } from '../audit/auditLog.js'
import { sealVaultFile, serializeVaultFile } from '../file/format.js'
import { createVault } from '../vaultFactory.js'

const dirs: string[] = []

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-vault-factory-'))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

function mutableSafeStorage(initial: string): {
  storage: SafeStorageLike
  setName(next: string): void
} {
  let name = initial
  return {
    storage: {
      isEncryptionAvailable: () => true,
      getSelectedStorageBackend: () => name,
      encryptString: (plain) => Buffer.from(plain, 'utf8'),
      decryptString: (encrypted) => Buffer.from(encrypted).toString('utf8')
    },
    setName(next: string) {
      name = next
    }
  }
}

describe('装配工厂护栏（S1 第 6 步收尾）', () => {
  it('护栏 A：默认装配绝不落到 memory', async () => {
    const dir = await tempDir()
    await expect(createVault({ keyFilePath: join(dir, 'keys.json') })).rejects.toMatchObject({
      code: ErrorCode.NOT_SUPPORTED
    })
  })

  it('注入 safeStorage 后默认装配走系统后端', async () => {
    const dir = await tempDir()
    const vault = await createVault({
      keyFilePath: join(dir, 'keys.json'),
      safeStorage: mutableSafeStorage('gnome_libsecret').storage
    })

    const diagnostic = await vault.diagnose()
    expect(diagnostic.backend).toBe('safeStorage')
    expect(diagnostic.severity).toBe('ok')
    expect(diagnostic.code).toBe('OK')
  })

  it('basic_text 诊断级别固定为 error（❌），且默认未确认', async () => {
    const dir = await tempDir()
    const vault = await createVault({
      keyFilePath: join(dir, 'keys.json'),
      safeStorage: mutableSafeStorage('basic_text').storage
    })

    const diagnostic = await vault.diagnose()
    expect(diagnostic.severity).toBe('error')
    expect(diagnostic.code).toBe('KEY_BACKEND_INSECURE')
    expect(diagnostic.acknowledged).toBe(false)
  })

  it('① 只有显式 acknowledgeInsecure() 才能置 acknowledged=true', async () => {
    const dir = await tempDir()
    const vault = await createVault({
      keyFilePath: join(dir, 'keys.json'),
      safeStorage: mutableSafeStorage('basic_text').storage
    })

    expect((await vault.diagnose()).acknowledged).toBe(false)
    const afterAck = await vault.acknowledgeInsecure()
    expect(afterAck.acknowledged).toBe(true)
    // 全量并发跑时，文件密钥环的首次写入会排队到 5 秒之外；单跑通常 1 秒内完成。
  }, 15_000)

  it('② 后端变更后 acknowledged 重置，且切回旧后端也不恢复', async () => {
    const dir = await tempDir()
    const fake = mutableSafeStorage('basic_text')
    const vault = await createVault({
      keyFilePath: join(dir, 'keys.json'),
      safeStorage: fake.storage
    })

    await vault.acknowledgeInsecure()
    expect((await vault.diagnose()).acknowledged).toBe(true)

    fake.setName('gnome_libsecret')
    expect((await vault.diagnose()).acknowledged).toBe(false)

    fake.setName('basic_text')
    expect((await vault.diagnose()).acknowledged).toBe(false)
  })

  it('③ acknowledged=true 只降低 UI 打扰，severity 仍为 error', async () => {
    const dir = await tempDir()
    const vault = await createVault({
      keyFilePath: join(dir, 'keys.json'),
      safeStorage: mutableSafeStorage('basic_text').storage
    })

    const diagnostic = await vault.acknowledgeInsecure()
    expect(diagnostic.acknowledged).toBe(true)
    expect(diagnostic.severity).toBe('error')
    expect(diagnostic.code).toBe('KEY_BACKEND_INSECURE')
  })

  it('护栏 B：memory 后端重启后旧文件解不开 → 改名保留证据并重新初始化', async () => {
    const dir = await tempDir()
    const path = join(dir, 'keys.json')

    const first = await createMemoryBackend()
    await createFileKeyRing({ path, backend: first })

    const afterRestart = await createMemoryBackend()
    const second = await createFileKeyRing({ path, backend: afterRestart })
    const diagnostic = await second.diagnostics()

    expect(diagnostic.recoveredFrom).toBeDefined()
    expect(diagnostic.recoveredFrom?.startsWith(`${path}.corrupt-`)).toBe(true)
    // 旧证据保留，新文件已重新生成。
    expect((await stat(diagnostic.recoveredFrom ?? '')).isFile()).toBe(true)
    expect((await stat(path)).isFile()).toBe(true)
  })

  it('17.2.13：recoveredFrom 只存在于诊断，不进入持久化信封', async () => {
    const dir = await tempDir()
    const path = join(dir, 'keys.json')
    await createFileKeyRing({ path, backend: await createMemoryBackend() })
    const recovered = await createFileKeyRing({ path, backend: await createMemoryBackend() })
    expect((await recovered.diagnostics()).recoveredFrom).toBeDefined()

    const file = await sealVaultFile(
      new AesGcmProvider(),
      new Uint8Array(32).fill(7),
      new TextEncoder().encode('payload'),
      { salt: new Uint8Array(16).fill(3), updatedAt: 1 }
    )

    expect(Object.keys(file).sort()).toEqual([
      'aad',
      'ciphertext',
      'kdf',
      'magic',
      'nonce',
      'suite',
      'updatedAt',
      'version'
    ])
    expect('recoveredFrom' in file).toBe(false)
    expect(serializeVaultFile(file)).not.toContain('recoveredFrom')
  })

  it('诊断项归入 credential 组下的 secure 细分类', async () => {    const dir = await tempDir()
    const vault = await createVault({
      keyFilePath: join(dir, 'keys.json'),
      safeStorage: mutableSafeStorage('basic_text').storage
    })

    const diagnostic = await vault.diagnose()
    expect(diagnostic.kind).toBe('secure')
    expect(diagnostic.group).toBe('credential')
  })

  it('17.2.10 ①：acknowledgeInsecure 写审计，未确认时不写', async () => {
    const dir = await tempDir()
    const audit = await createAuditLog(join(dir, 'audit.log'))
    const vault = await createVault({
      keyFilePath: join(dir, 'keys.json'),
      safeStorage: mutableSafeStorage('basic_text').storage,
      audit,
      appVersion: '2.0.0-dev.0'
    })

    // 重复诊断不应产生任何审计：自动确认一旦出现就是 bug。
    await vault.diagnose()
    await vault.diagnose()
    expect(await audit.entries()).toHaveLength(0)

    await vault.acknowledgeInsecure()

    const entries = await audit.entries()
    expect(entries).toHaveLength(1)
    expect(entries[0]?.event).toBe('key_backend_insecure')
    expect(entries[0]?.details.backend).toBe('safeStorage')
    expect(entries[0]?.details.keyId).toBe(1)
    expect(entries[0]?.details.source).toBe('user')
    expect(entries[0]?.details.appVersion).toBe('2.0.0-dev.0')

    // 17.2.13：自动确认一旦出现即为 bug —— key_backend_insecure 不允许 source=system。
    expect(
      entries.some(
        (entry) =>
          entry.event === 'key_backend_insecure' && entry.details.source === 'system'
      )
    ).toBe(false)
  })

  it('acknowledged 只抑制弹窗：篡改 state.json 不改变 severity=error', async () => {
    const dir = await tempDir()
    const stateFilePath = join(dir, 'state.json')
    await writeFile(
      stateFilePath,
      JSON.stringify({ version: 1, acknowledgedBackend: 'safeStorage:false' }),
      'utf8'
    )

    const vault = await createVault({
      keyFilePath: join(dir, 'keys.json'),
      safeStorage: mutableSafeStorage('basic_text').storage,
      stateFilePath
    })

    const diagnostic = await vault.diagnose()
    expect(diagnostic.acknowledged).toBe(true)
    expect(diagnostic.severity).toBe('error')
    expect(diagnostic.code).toBe('KEY_BACKEND_INSECURE')
  })

  it('17.2.10 三态：未确认 → 确认 → 切后端重置', async () => {
    const dir = await tempDir()
    const fake = mutableSafeStorage('basic_text')
    const vault = await createVault({
      keyFilePath: join(dir, 'keys.json'),
      safeStorage: fake.storage
    })

    const unconfirmed = await vault.diagnose()
    expect(unconfirmed.severity).toBe('error')
    expect(unconfirmed.acknowledged).toBe(false)

    const acknowledged = await vault.acknowledgeInsecure()
    expect(acknowledged.acknowledged).toBe(true)
    expect(acknowledged.severity).toBe('error')

    fake.setName('gnome_libsecret')
    expect((await vault.diagnose()).acknowledged).toBe(false)
  })

  it('17.2.10 ②：确认态只落本机 state.json，重启保留，后端变更后清空', async () => {
    const dir = await tempDir()
    const stateFilePath = join(dir, 'state.json')
    const fake = mutableSafeStorage('basic_text')

    const first = await createVault({
      keyFilePath: join(dir, 'keys.json'),
      safeStorage: fake.storage,
      stateFilePath
    })
    await first.acknowledgeInsecure()

    const restarted = await createVault({
      keyFilePath: join(dir, 'keys.json'),
      safeStorage: fake.storage,
      stateFilePath
    })
    expect((await restarted.diagnose()).acknowledged).toBe(true)

    fake.setName('gnome_libsecret')
    expect((await restarted.diagnose()).acknowledged).toBe(false)

    // 切回旧后端也不恢复：state 已在检测到变更时清空。
    fake.setName('basic_text')
    expect((await restarted.diagnose()).acknowledged).toBe(false)

    const state = JSON.parse(await readFile(stateFilePath, 'utf8')) as {
      acknowledgedBackend?: string
    }
    expect(state.acknowledgedBackend).toBeUndefined()
  })
})
