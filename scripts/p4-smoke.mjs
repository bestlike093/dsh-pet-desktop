// P4 冒烟：模块清单、沙箱与内置模块
import {
  ModuleHost,
  PetalRegistry,
  PermissionBroker,
  REMINDER_KEY,
  balanceModule,
  bubbleModule,
  createSandboxContext,
  parsePetalManifest,
  reminderModule
} from '../packages/core/dist/index.js'

let failed = 0
function check(name, ok, extra = '') {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : ''))
  if (!ok) failed += 1
}

// 1. 清单校验
const valid = parsePetalManifest({
  id: 'demo.pet',
  name: '演示模块',
  version: '1.2.3',
  entry: 'index.mjs',
  permissions: ['ui.render', 'ui.render', 'memory.read'],
  minHostVersion: '2.0.0',
  unknownField: 'ignored'
})
check('manifest: 合法清单通过', valid.ok === true && valid.manifest.id === 'demo.pet')
check('manifest: 权限去重', valid.ok === true && valid.manifest.permissions.length === 2)
check('manifest: 未知字段被忽略', valid.ok === true && !('unknownField' in valid.manifest))

const badCases = [
  ['非对象', 'nope'],
  ['大写 id', { id: 'Demo', name: 'x', version: '1.0.0', entry: 'a.js', permissions: [] }],
  ['缺 name', { id: 'demo', version: '1.0.0', entry: 'a.js', permissions: [] }],
  ['坏版本', { id: 'demo', name: 'x', version: '1.0', entry: 'a.js', permissions: [] }],
  ['越界入口', { id: 'demo', name: 'x', version: '1.0.0', entry: '../evil.js', permissions: [] }],
  ['非 js 入口', { id: 'demo', name: 'x', version: '1.0.0', entry: 'index.exe', permissions: [] }],
  ['未知权限', { id: 'demo', name: 'x', version: '1.0.0', entry: 'a.js', permissions: ['root.all'] }]
]
for (const [label, raw] of badCases) {
  const result = parsePetalManifest(raw)
  check(`manifest: ${label} 被拒`, result.ok === false && result.error.code === 'LOAD_FAILED')
}

// 2. 沙箱权限裁剪
const fakeRoot = { querySelector: () => null }
const rendered = []
const fetched = []
const written = []
const ports = {
  render: (html) => rendered.push(html),
  fetch: async (input) => {
    fetched.push(input)
    return { ok: true }
  },
  readMemory: async () => 'old-value',
  writeMemory: async (key, value) => {
    written.push([key, value])
  }
}

const emptyCtx = createSandboxContext({
  root: fakeRoot,
  config: { enabled: true, granted: [], options: {} },
  granted: [],
  ports
})
check(
  'sandbox: 无权限时接口不存在',
  emptyCtx.api.ui === undefined &&
    emptyCtx.api.net === undefined &&
    emptyCtx.api.fs === undefined &&
    emptyCtx.api.memory === undefined
)

const uiCtx = createSandboxContext({
  root: fakeRoot,
  config: { enabled: true, granted: [], options: {} },
  granted: ['ui.render', 'memory.read'],
  ports
})
check('sandbox: 授予 ui.render 后出现 ui', uiCtx.api.ui !== undefined)
uiCtx.api.ui.render('<b>ok</b>')
check('sandbox: ui.render 转发到端口', rendered.length === 1 && rendered[0] === '<b>ok</b>')
check('sandbox: 未授予的 memory.write 不存在', 'write' in uiCtx.api.memory === false)
check('sandbox: memory.read 可用', (await uiCtx.api.memory.read('k')) === 'old-value')

const portlessCtx = createSandboxContext({
  root: fakeRoot,
  config: { enabled: true, granted: [], options: {} },
  granted: ['net.egress']
})
let portCode = null
try {
  await portlessCtx.api.net.fetch('https://example.com')
} catch (error) {
  portCode = error.code
}
check('sandbox: 缺端口时报 NOT_SUPPORTED', portCode === 'NOT_SUPPORTED')

// 3. 内置模块与宿主
const registry = new PetalRegistry()
registry.register(bubbleModule)
registry.register(reminderModule)
registry.register(balanceModule)
const permissions = new PermissionBroker(['ui.render', 'memory.read', 'memory.write'])
const host = new ModuleHost(registry, permissions, { root: fakeRoot, timeoutMs: 200, sandboxPorts: ports })

check('builtin: 气泡模块启动', (await host.start('builtin.bubble')) === true)
check('builtin: 气泡渲染被调用', rendered.length === 2)
check('builtin: 提醒模块启动', (await host.start('builtin.reminder')) === true)
check(
  'builtin: 提醒写入记忆',
  written.length === 1 && written[0][0] === REMINDER_KEY && written[0][1].previous === 'old-value'
)
check('builtin: 余额模块缺权限被拒', (await host.start('builtin.balance')) === false)
check(
  'builtin: 余额失败原因可见',
  host.statuses().find((item) => item.id === 'builtin.balance').code === 'PERMISSION_DENIED'
)

permissions.grant(['net.egress'])
check('builtin: 补授权限后可启动余额', (await host.start('builtin.balance')) === true)
check('builtin: 余额请求打到默认端点', fetched.length === 1 && fetched[0].includes('deepseek'))

const beforeStop = rendered.length
await host.stop('builtin.bubble')
check('builtin: 停止气泡', host.statuses().find((item) => item.id === 'builtin.bubble').status === 'stopped')
check('builtin: 停止不重复渲染', rendered.length === beforeStop)
check('builtin: 可重新启动', (await host.start('builtin.bubble')) === true)
check('builtin: 重启后重新渲染', rendered.length === beforeStop + 1)

await host.stopAll()
check('builtin: stopAll 全部停止', host.statuses().every((item) => item.status === 'stopped'))
check('builtin: describe 汇总', host.describe().includes('builtin.bubble=stopped'))

// 4. 缺权限的第三方模块不影响已运行模块
const rogue = {
  meta: { id: 'rogue.module', name: '越权模块', version: '1.0.0', permissions: ['dsh.decision.commit'] },
  async bootstrap() {
    throw new Error('should not reach')
  },
  async teardown() {}
}
registry.register(rogue)
check('host: 越权模块启动失败', (await host.start('rogue.module')) === false)
check(
  'host: 失败码为 PERMISSION_DENIED',
  host.statuses().find((item) => item.id === 'rogue.module').code === 'PERMISSION_DENIED'
)
check('host: 其他模块仍可正常启动', (await host.start('builtin.bubble')) === true)

console.log('\nP4_SMOKE_' + (failed === 0 ? 'OK' : 'FAILED_' + failed))
process.exit(failed === 0 ? 0 : 1)
