// P0 冒烟：只验证已编译产物的行为，不依赖 Electron / 浏览器
import { AssetManager, Diagnostics, DshBridge, PermissionBroker } from '../packages/core/dist/index.js'
import { AesGcmProvider, SUITE_CS1 } from '../packages/vault/dist/index.js'
import { EventBus, HybridClock, compareHlc, migrateSettings } from '../packages/shared/dist/index.js'

let failed = 0
function check(name, ok, extra = '') {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : ''))
  if (!ok) failed += 1
}

// 1. 宿主缺失时的降级
const bridge = DshBridge.connect()
const caps = bridge.capabilities()
check('bridge: 无宿主 ask=false', caps.ask === false)
check('bridge: describe 标出 none', bridge.describe().includes('none'), bridge.describe())
let askCode = null
try {
  await bridge.ask({ id: 'a1', question: 'test' })
} catch (error) {
  askCode = error.code
}
check('bridge: ask 降级为 NOT_SUPPORTED', askCode === 'NOT_SUPPORTED', String(askCode))

// 2. CS1 加密往返
const provider = new AesGcmProvider()
check('crypto: 套件为 CS1', provider.suite === SUITE_CS1)
check('crypto: WebCrypto 可用', await provider.available())

const salt = new Uint8Array(16).fill(7)
const key = await provider.deriveKey('correct horse battery staple', salt)
const aad = new TextEncoder().encode('vault-v2')
const secret = '示例文本：今天也要开心'
const plaintext = new TextEncoder().encode(secret)
const box = await provider.seal(key, plaintext, aad)
check('crypto: 密文非空', box.ciphertext.length > 0)
check('crypto: nonce 为 12 字节', atob(box.nonce).length === 12)

const opened = await provider.open(key, box, aad)
check('crypto: 解密还原一致', new TextDecoder().decode(opened) === secret)

let aadRejected = false
try {
  await provider.open(key, box, new TextEncoder().encode('vault-v3'))
} catch {
  aadRejected = true
}
check('crypto: AAD 不匹配即解密失败', aadRejected)

const wrongKey = await provider.deriveKey('wrong password', salt)
let keyRejected = false
try {
  await provider.open(wrongKey, box, aad)
} catch {
  keyRejected = true
}
check('crypto: 错误口令无法解密', keyRejected)

// 3. HLC 单调
const clock = new HybridClock('dev')
const t1 = clock.now()
const t2 = clock.now()
check('hlc: 本地连续时间戳递增', compareHlc(t1, t2) < 0, `${t1} < ${t2}`)
const t3 = clock.receive('99999999999990000-remote')
check('hlc: 吸收远端后仍递增', compareHlc(t2, t3) < 0, `${t2} < ${t3}`)

// 4. 事件总线隔离
const bus = new EventBus()
let received = 0
bus.on('ping', () => {
  received += 1
})
bus.on('ping', () => {
  throw new Error('listener boom')
})
bus.emit('ping', null)
check('eventbus: 单个监听器抛错不阻断其他', received === 1, `received=${received}`)

// 5. Settings v1 → v2 迁移
const migrated = migrateSettings({
  schemaVersion: 1,
  nickname: '  小鹿  ',
  ui: 'card',
  scale: 0.9,
  font: 30,
  bubbleRadius: 12,
  bubbleAlpha: 0.8,
  showHud: true,
  hudDetail: 'simple',
  askEvery: 15,
  askHandling: 'both',
  poseEvery: 90,
  soundLevel: 0.4,
  customThing: 'keep-me'
})
check('settings: v1 迁移成功', migrated.ok === true)
check('settings: nickname 去空白', migrated.ok && migrated.value.nickname === '小鹿')
check('settings: ui → uiMode', migrated.ok && migrated.value.uiMode === 'card')
check(
  'settings: scale/font/radius 映射',
  migrated.ok &&
    migrated.value.window.scale === 0.9 &&
    migrated.value.bubble.fontSize === 30 &&
    migrated.value.bubble.radius === 12
)
check(
  'settings: askEvery/poseEvery 映射',
  migrated.ok && migrated.value.askEveryMinutes === 15 && migrated.value.poseEverySeconds === 90
)
check('settings: 未知字段保留在 legacy', migrated.ok && migrated.legacy.customThing === 'keep-me')

const clamped = migrateSettings({ schemaVersion: 1, scale: 99, font: 1, bubbleAlpha: 5 })
check(
  'settings: 越界值被夹取',
  clamped.ok &&
    clamped.value.window.scale === 3 &&
    clamped.value.bubble.fontSize === 8 &&
    clamped.value.bubble.alpha === 1
)

const unsupported = migrateSettings({ schemaVersion: 7 })
check(
  'settings: 未知版本迁移失败',
  unsupported.ok === false && unsupported.error.code === 'SETTINGS_MIGRATION_FAILED'
)
check('settings: 非对象输入被拒绝', migrateSettings('nope').ok === false)

const directV2 = migrateSettings({ schemaVersion: 2, nickname: '小鹿', window: { scale: 1.1 } })
check('settings: v2 直接接受', directV2.ok === true && directV2.value.window.scale === 1.1)

// 6. 资产边界
const assets = new AssetManager('C:/pet-root')
const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
const verified = assets.verify('assets/立绘.png', pngBytes)
check('asset: png 通过魔数校验', verified.mime === 'image/png' && verified.kind === 'image')
// 断言只看「root 之后的部分」，盘符与分隔符由平台决定：
// Windows 是 C:/pet-root/...，Linux 是 /pet-root/... 或 <cwd>/C:/pet-root/...
check(
  'asset: 绝对路径拼接',
  verified.absolutePath.replace(/\\/g, '/').endsWith('/assets/立绘.png'),
  verified.absolutePath
)

let magicCode = null
try {
  assets.verify('assets/fake.png', new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))
} catch (error) {
  magicCode = error.code
}
check('asset: 扩展名与魔数不符被拒', magicCode === 'ASSET_INVALID_MAGIC')

let escapeCode = null
try {
  assets.resolve('../secrets.txt')
} catch (error) {
  escapeCode = error.code
}
check('asset: 路径越界被拦截', escapeCode === 'PATH_TRAVERSAL')

let absoluteCode = null
try {
  assets.resolve('C:/Windows/system.ini')
} catch (error) {
  absoluteCode = error.code
}
check('asset: 绝对路径被拦截', absoluteCode === 'PATH_TRAVERSAL')

const tiny = new AssetManager('C:/pet-root', { maxBytes: 4 })
let sizeCode = null
try {
  tiny.verify('a.png', pngBytes)
} catch (error) {
  sizeCode = error.code
}
check('asset: 超过大小上限被拒', sizeCode === 'QUOTA_EXCEEDED')

let extCode = null
try {
  assets.verify('a.exe', pngBytes)
} catch (error) {
  extCode = error.code
}
check('asset: 扩展名白名单生效', extCode === 'MIME_MISMATCH')

const jsonAsset = assets.verify('a.json', new TextEncoder().encode('{"ok":true}'))
check('asset: json 内容识别', jsonAsset.mime === 'application/json' && jsonAsset.kind === 'json')

// 7. 权限运行时
const broker = new PermissionBroker()
let deniedCode = null
try {
  broker.assert('net.egress')
} catch (error) {
  deniedCode = error.code
}
check('perm: 默认拒绝未授权权限', deniedCode === 'PERMISSION_DENIED')
broker.grant(['net.egress'])
check('perm: 授予后通过', broker.has('net.egress') === true)
broker.revoke(['net.egress'])
check('perm: 撤销后失效', broker.has('net.egress') === false)
check('perm: 审计记录完整', broker.audit().map((item) => item.action).join(',') === 'deny,grant,revoke', JSON.stringify(broker.audit()))

let unknownPerm = null
try {
  broker.grant(['root.all'])
} catch (error) {
  unknownPerm = error.code
}
check('perm: 未知权限被拒绝', unknownPerm === 'INVALID_ARGUMENT')

// 8. 诊断聚合
const diag = new Diagnostics({ version: '2.0.0-dev.0', bridge, now: () => 123 })
diag.register('ok', () => ({ ready: true }))
diag.register('boom', () => {
  throw new Error('provider exploded')
})
const snapshot = await diag.collect()
check('diag: 版本与时间注入', snapshot.version === '2.0.0-dev.0' && snapshot.generatedAt === 123)
check('diag: 单节失败不影响其他', snapshot.sections.length === 2 && snapshot.ok === false)
check(
  'diag: 失败节带错误码',
  snapshot.sections.find((section) => section.name === 'boom')?.code === 'UNKNOWN'
)
check('diag: bridge 描述可见', snapshot.bridge.includes('none'))

console.log('\nP0_SMOKE_' + (failed === 0 ? 'OK' : 'FAILED_' + failed))
process.exit(failed === 0 ? 0 : 1)
