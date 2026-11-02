// 最小可用版冒烟：四媒体入口、决策网关、QQ 通道、模块隔离、Electron 文件完整性
import { generateKeyPairSync, sign } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  AdapterRegistry,
  DecisionGateway,
  LocalLoopbackChannel,
  ModuleHost,
  PermissionBroker,
  PetalRegistry,
  createGifAdapter,
  createImageAdapter,
  createLive2DAdapter,
  createVideoAdapter
} from '../packages/core/dist/index.js'
import { ErrorCode, mediaKindForName } from '../packages/shared/dist/index.js'
import { QqOfficialChannel } from '../apps/desktop/dist/remote/qqOfficialChannel.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
let pass = 0
let fail = 0

function check(ok, label) {
  if (ok) {
    pass += 1
    console.log(`PASS ${label}`)
  } else {
    fail += 1
    console.log(`FAIL ${label}`)
  }
}

async function expectCode(fn, code, label) {
  try {
    await fn()
    check(false, `${label}（没有抛错）`)
  } catch (error) {
    check(error?.code === code, `${label}（实际 ${error?.code ?? error}）`)
  }
}

// ---------- 四媒体入口 ----------
check(mediaKindForName('a.png') === 'image', 'png → image')
check(mediaKindForName('a.JPEG') === 'image', 'jpeg 大小写不敏感')
check(mediaKindForName('a.webp') === 'image', 'webp → image')
check(mediaKindForName('a.gif') === 'gif', 'gif → gif')
check(mediaKindForName('a.mp4') === 'video', 'mp4 → video')
check(mediaKindForName('a.model3.json') === 'live2d', 'model3.json → live2d')
check(mediaKindForName('a.txt') === null, '未知扩展名 → null')

const adapters = new AdapterRegistry()
adapters.register(createImageAdapter())
adapters.register(createGifAdapter())
adapters.register(createVideoAdapter())
adapters.register(createLive2DAdapter({ fallback: createImageAdapter() }))
const kinds = adapters.kinds()
check(
  ['image', 'gif', 'video', 'live2d'].every((kind) => kinds.includes(kind)),
  `四适配器已注册：${kinds.join(' / ')}`
)

// ---------- 决策网关 ----------
const local = new LocalLoopbackChannel()
const gateway = new DecisionGateway({ deviceId: 'smoke', channels: [local], timeoutMs: 200 })

const envelope = await gateway.prepare({
  kind: 'approval',
  summary: '允许一次示例任务？',
  payload: { task: 'demo' },
  ttlMs: 500
})
check(/^[0-9a-f]{8}$/.test(envelope.id), `envelope id 为 8 位短 id：${envelope.id}`)
check(envelope.payloadCipher.startsWith('plain:'), 'payload 以 plain: 承载（待 Vault 加密）')
check(envelope.expiresAt > Date.now(), 'envelope 带过期时间')
check(local.sentCount === 1, '本地回环收到 envelope')

local.reply(envelope.id, 'allow')
const outcome = await gateway.wait(envelope.id)
check(outcome.status === 'allowed', `本地回环允许 → ${outcome.status}`)
await expectCode(() => gateway.resolve(envelope.id, 'deny'), ErrorCode.DECISION_NOT_FOUND, '重复决定被拒绝')

const timeout = await gateway.ask({ kind: 'approval', summary: '超时测试', ttlMs: 30 })
check(timeout.status === 'timeout' && timeout.usedFallback, '超时回退本地（fallback-local）')

const blocking = new DecisionGateway({
  deviceId: 'smoke',
  channels: [new LocalLoopbackChannel()],
  timeoutPolicy: 'block',
  timeoutMs: 20
})
await expectCode(
  () => blocking.ask({ kind: 'approval', summary: '阻塞超时', ttlMs: 20 }),
  ErrorCode.DECISION_TIMEOUT,
  'block 模式超时抛 DECISION_TIMEOUT'
)

await expectCode(
  () => Promise.resolve().then(() => new DecisionGateway({ deviceId: 'smoke', channels: [] })),
  ErrorCode.CHANNEL_NOT_CONFIGURED,
  '没有通道时拒绝创建网关'
)

const broken = {
  id: 'broken',
  capabilities: () => ({ approval: false, question: false, richCard: false, memorySync: false }),
  send: async () => {
    throw new Error('offline')
  },
  onReply: () => () => {},
  health: async () => ({ ok: false })
}
const brokenGateway = new DecisionGateway({ deviceId: 'smoke', channels: [broken], timeoutMs: 50 })
await expectCode(
  () => brokenGateway.prepare({ kind: 'approval', summary: '通道全挂', ttlMs: 50 }),
  ErrorCode.CHANNEL_NOT_CONFIGURED,
  '所有通道发送失败时明确报错'
)

// ---------- QQ 官方通道 ----------
const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const publicKeyHex = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex')

const calls = []
const fakeFetch = async (url, init) => {
  calls.push({ url, init })
  if (String(url).includes('getAppAccessToken')) {
    return new Response(JSON.stringify({ access_token: 'tok', expires_in: 7200 }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
  }
  return new Response(JSON.stringify({ id: 'qq-msg-1' }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })
}

const qq = new QqOfficialChannel({
  appId: 'app',
  clientSecret: 'secret',
  publicKey: publicKeyHex,
  target: { kind: 'c2c', openId: 'openid-1' },
  ownerOpenIds: ['openid-owner'],
  fetchImpl: fakeFetch,
  now: () => 1_000_000
})

const qqEnvelope = {
  id: 'abcd1234',
  kind: 'approval',
  deviceId: 'smoke',
  hlc: { wall: 1, counter: 0, node: 'smoke' },
  nonce: 'nonce',
  expiresAt: 1_000_000 + 60_000,
  summary: 'QQ 远程拍板',
  payloadCipher: 'plain:bnVsbA==',
  sig: '',
  keyEpoch: 0
}

const delivered = await qq.send(qqEnvelope)
check(delivered.messageId === 'qq-msg-1', 'QQ send 返回消息 id')
const sentCall = calls.find((call) => String(call.url).includes('/v2/users/openid-1/messages'))
check(sentCall !== undefined, 'QQ 走 C2C 官方发送地址')
check(sentCall?.init.headers.authorization === 'QQBot tok', 'QQ 请求带 QQBot access_token')
check(
  String(sentCall?.init.body).includes('allow abcd1234') && String(sentCall?.init.body).includes('deny abcd1234'),
  'QQ 消息正文包含 allow/deny 指令'
)

const replies = []
qq.onReply((reply) => replies.push(reply))

const webhookBody = JSON.stringify({
  t: 'C2C_MESSAGE_CREATE',
  d: {
    id: 'm1',
    content: 'allow abcd1234',
    author: { user_openid: 'openid-owner' }
  }
})
const timestamp = '1700000000'
const signature = sign(null, Buffer.from(`${timestamp}${webhookBody}`), privateKey).toString('hex')
const accepted = await qq.handleWebhook(webhookBody, {
  'x-signature-ed25519': signature,
  'x-signature-timestamp': timestamp
})
check(accepted.ok === true && accepted.accepted === true, 'QQ webhook 验签通过并接受指令')
check(replies.length === 1 && replies[0].action === 'allow' && replies[0].envelopeId === 'abcd1234', 'QQ 指令转成 DecisionReply')
check(
  replies[0]?.sender?.channelId === 'qq' &&
    replies[0]?.sender?.id === 'openid-owner' &&
    replies[0]?.sender?.chatType === 'private',
  'QQ 回复带上主人 openid 与会话类型'
)

// 名单外的人即使能通过验签、知道指令格式，也不能产生回复。
const outsiderBody = JSON.stringify({
  t: 'C2C_MESSAGE_CREATE',
  d: {
    id: 'm2',
    content: 'allow abcd1234',
    author: { user_openid: 'openid-outsider' }
  }
})
const outsiderSig = sign(null, Buffer.from(`${timestamp}${outsiderBody}`), privateKey).toString('hex')
const outsiderResult = await qq.handleWebhook(outsiderBody, {
  'x-signature-ed25519': outsiderSig,
  'x-signature-timestamp': timestamp
})
check(outsiderResult.ok === true && outsiderResult.ignored === true, '名单外消息被忽略')
check(replies.length === 1, '名单外消息不产生 DecisionReply')

await expectCode(
  () =>
    qq.handleWebhook(webhookBody, {
      'x-signature-ed25519': '00'.repeat(64),
      'x-signature-timestamp': timestamp
    }),
  ErrorCode.SIGNATURE_INVALID,
  '篡改签名被拒绝'
)

const verifyBody = JSON.stringify({ op: 13, d: { plain_token: 'token-1', event_ts: '1700000001' } })
const verifyTs = '1700000001'
const verifySig = sign(null, Buffer.from(`${verifyTs}${verifyBody}`), privateKey).toString('hex')
const challenge = await qq.handleWebhook(verifyBody, {
  'x-signature-ed25519': verifySig,
  'x-signature-timestamp': verifyTs
})
check(challenge.plain_token === 'token-1', 'QQ op13 回显 plain_token')
check(
  typeof challenge.signature === 'string' && challenge.signature.length === 128,
  'QQ op13 返回 64 字节 Ed25519 签名'
)

const unconfigured = new QqOfficialChannel({ appId: '', clientSecret: '' })
const health = await unconfigured.health()
check(health.ok === false && health.code === ErrorCode.CHANNEL_NOT_CONFIGURED, 'QQ 未配置时 health 明确报错')

// 没有公钥就没法验签：任何 webhook 都必须被拒，不能放行伪造的 allow/deny。
const noKey = new QqOfficialChannel({ appId: 'app', clientSecret: 'secret' })
let noKeyRejected = false
try {
  await noKey.handleWebhook('{"op":13,"d":{"event_ts":"1","plain_token":"t"}}', {
    'x-signature-timestamp': '1',
    'x-signature-ed25519': '00'.repeat(64)
  })
} catch (error) {
  noKeyRejected = error?.code === ErrorCode.CHANNEL_NOT_CONFIGURED
}
check(noKeyRejected, 'QQ 未配公钥时拒绝处理 webhook')

// ---------- 模块崩溃隔离 ----------
const petalRegistry = new PetalRegistry()
const permissions = new PermissionBroker(['ui.render'])
const rootNode = { appendChild: () => {} }
const moduleHost = new ModuleHost(petalRegistry, permissions, { root: rootNode, timeoutMs: 200 })

petalRegistry.register({
  meta: { id: 'healthy', name: '正常', version: '1.0.0', permissions: ['ui.render'] },
  async bootstrap() {},
  async teardown() {},
  async diagnose() {
    return { ok: true }
  }
})
petalRegistry.register({
  meta: { id: 'exploding', name: '崩溃', version: '1.0.0', permissions: ['ui.render'] },
  async bootstrap() {
    throw new Error('boom')
  },
  async teardown() {},
  async diagnose() {
    return { ok: true }
  }
})

check(await moduleHost.start('healthy'), '正常模块启动成功')
check((await moduleHost.start('exploding')) === false, '崩溃模块启动失败但被隔离')
check(moduleHost.describe().includes('exploding=failed'), `模块状态可诊断：${moduleHost.describe()}`)

// ---------- Electron 壳文件 ----------
const mainPath = join(root, 'apps/desktop/electron/main.mjs')
const preloadPath = join(root, 'apps/desktop/electron/preload.cjs')
const htmlPath = join(root, 'apps/desktop/electron/renderer/index.html')
const rendererPath = join(root, 'apps/desktop/electron/renderer/renderer.mjs')

for (const [label, file] of [
  ['main.mjs', mainPath],
  ['preload.cjs', preloadPath],
  ['renderer/index.html', htmlPath],
  ['renderer/renderer.mjs', rendererPath]
]) {
  check(existsSync(file), `Electron 入口存在：${label}`)
}

const preload = readFileSync(preloadPath, 'utf8')
check(preload.includes("contextBridge.exposeInMainWorld('pet'"), 'preload 通过 contextBridge 暴露 pet')
check(preload.includes('pet:ask') && preload.includes('pet:approve'), 'preload 暴露决策方法')
check(!preload.includes('exposeInMainWorld(\'ipcRenderer\''), 'preload 不直接暴露 ipcRenderer')

const html = readFileSync(htmlPath, 'utf8')
check(html.includes("default-src 'self'"), 'renderer 有 CSP')
check(html.includes('type="module"'), 'renderer 使用 module script')

const renderer = readFileSync(rendererPath, 'utf8')
for (const factory of ['createImageAdapter', 'createGifAdapter', 'createVideoAdapter', 'createLive2DAdapter']) {
  check(renderer.includes(factory), `renderer 接入 ${factory}`)
}
check(renderer.includes('unhandledrejection'), 'renderer 捕获未处理异常，避免白屏')

console.log('')
console.log(`SUMMARY ${pass} pass, ${fail} fail`)
process.exit(fail === 0 ? 0 : 1)
