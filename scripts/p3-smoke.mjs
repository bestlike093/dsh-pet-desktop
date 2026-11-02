// P3 冒烟：桌面壳契约层，不加载 Electron
import {
  IPC_CHANNELS,
  IpcRouter,
  PRELOAD_METHODS,
  WindowController,
  assertChannel,
  createDesktopBridge,
  createHostAdapter,
  createPreloadApi,
  createWindowOptions
} from '../apps/desktop/dist/index.js'
import { DEFAULT_SETTINGS, SIZE_PROFILES } from '../packages/shared/dist/index.js'

let failed = 0
function check(name, ok, extra = '') {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : ''))
  if (!ok) failed += 1
}

// 1. IPC 通道白名单
// 断言核心通道在册且不重复；具体条数随功能增长，写死数字只会让断言过期。
const CORE_CHANNELS = [
  'pet:ask',
  'pet:approve',
  'pet:reportTask',
  'pet:settings:get',
  'pet:settings:save',
  'pet:window:setClickThrough'
]
check(
  'ipc: 白名单包含核心通道',
  CORE_CHANNELS.every((channel) => IPC_CHANNELS.includes(channel)) &&
    new Set(IPC_CHANNELS).size === IPC_CHANNELS.length
)
let allowed = true
try {
  assertChannel('pet:ask')
} catch {
  allowed = false
}
check('ipc: 白名单内通道放行', allowed === true)
let deniedCode = null
try {
  assertChannel('pet:evil')
} catch (error) {
  deniedCode = error.code
}
check('ipc: 白名单外通道拒绝', deniedCode === 'PERMISSION_DENIED')

const router = new IpcRouter()
const off = router.handle('pet:ask', async (payload) => ({ echo: payload }))
check('ipc: 已注册通道可调用', (await router.invoke({ channel: 'pet:ask', payload: { q: 1 } })).echo.q === 1)
check('ipc: 路由器只列出已注册通道', router.channels().length === 1)

let unregisteredCode = null
try {
  await router.invoke({ channel: 'pet:approve' })
} catch (error) {
  unregisteredCode = error.code
}
check('ipc: 合法但未注册通道报 NOT_SUPPORTED', unregisteredCode === 'NOT_SUPPORTED')

off()
let removedCode = null
try {
  await router.invoke({ channel: 'pet:ask' })
} catch (error) {
  removedCode = error.code
}
check('ipc: 注销后不可调用', removedCode === 'NOT_SUPPORTED')

// 2. preload 只暴露固定方法
const invoked = []
const api = createPreloadApi(async (channel, payload) => {
  invoked.push({ channel, payload })
  return 'ok'
})
check(
  'preload: 方法表无重复且非空',
  PRELOAD_METHODS.length > 0 && new Set(PRELOAD_METHODS).size === PRELOAD_METHODS.length
)
check(
  'preload: 方法表与实现一致',
  Object.keys(api).length === PRELOAD_METHODS.length &&
    PRELOAD_METHODS.every((name) => typeof api[name] === 'function')
)
await api.ask('在吗', ['在', '不在'])
check(
  'preload: ask 绑定固定通道',
  invoked[0].channel === 'pet:ask' && invoked[0].payload.question === '在吗'
)
await api.saveSettings({ nickname: '小鹿' })
check('preload: saveSettings 绑定固定通道', invoked[1].channel === 'pet:settings:save')
api.reportTask({ id: 't1', label: '测试', ratio: 0.5, state: 'running' })
check('preload: reportTask 绑定固定通道', invoked[2].channel === 'pet:reportTask')
await api.move(10, 20)
check('preload: move 参数封装', invoked[3].payload.x === 10 && invoked[3].payload.y === 20)
await api.setClickThrough(true)
check('preload: 穿透开关封装', invoked[4].channel === 'pet:window:setClickThrough')

// 3. 窗口参数
const defaults = createWindowOptions(DEFAULT_SETTINGS, 'preload.cjs')
check(
  'window: 尺寸按 profile 与 scale 计算',
  defaults.width === Math.round(SIZE_PROFILES.vertical.w * DEFAULT_SETTINGS.window.scale) &&
    defaults.height === Math.round(SIZE_PROFILES.vertical.h * DEFAULT_SETTINGS.window.scale)
)
check('window: 透明无边框', defaults.transparent === true && defaults.frame === false)
check('window: 置顶跟随设置', defaults.alwaysOnTop === DEFAULT_SETTINGS.window.alwaysOnTop)
check(
  'window: 渲染进程隔离',
  defaults.webPreferences.contextIsolation === true &&
    defaults.webPreferences.nodeIntegration === false &&
    defaults.webPreferences.sandbox === true
)

const custom = createWindowOptions(
  {
    ...DEFAULT_SETTINGS,
    profile: 'custom',
    window: { ...DEFAULT_SETTINGS.window, scale: 1.5, x: 100, y: 200 }
  },
  'preload.cjs'
)
check(
  'window: custom profile 回落到 vertical',
  custom.width === Math.round(SIZE_PROFILES.vertical.w * 1.5) && custom.x === 100 && custom.y === 200
)

const card = createWindowOptions({ ...DEFAULT_SETTINGS, profile: 'card' }, 'preload.cjs')
check('window: card profile 使用卡片尺寸', card.width === Math.round(SIZE_PROFILES.card.w * 0.7))

// 4. 窗口控制器
function fakeWindow(bounds = { x: 10, y: 20, width: 420, height: 560 }) {
  const calls = []
  return {
    calls,
    setIgnoreMouseEvents: (ignore, options) => calls.push(['ignore', ignore, options]),
    setAlwaysOnTop: (flag) => calls.push(['top', flag]),
    getBounds: () => bounds,
    setBounds: (next) => calls.push(['bounds', next]),
    loadFile: async () => calls.push(['load']),
    show: () => calls.push(['show']),
    hide: () => calls.push(['hide']),
    isDestroyed: () => false
  }
}

const win = fakeWindow()
const persisted = []
const controller = new WindowController(win, {
  initialPosition: { x: 30, y: 40 },
  persist: (bounds) => persisted.push(bounds)
})
controller.restorePosition()
check('window-controller: 恢复位置', win.calls[0][0] === 'bounds' && win.calls[0][1].x === 30)

controller.setClickThrough(true)
check(
  'window-controller: 穿透带 forward',
  win.calls[1][0] === 'ignore' && win.calls[1][1] === true && win.calls[1][2].forward === true
)
check('window-controller: 记录穿透状态', controller.isClickThrough === true)
check('window-controller: toggle 关闭穿透', controller.toggleClickThrough() === false)

controller.setAlwaysOnTop(true)
check('window-controller: 置顶转发', win.calls.at(-1)[0] === 'top' && win.calls.at(-1)[1] === true)

const saved = await controller.savePosition()
check('window-controller: 位置持久化', persisted.length === 1 && saved.x === 10 && saved.width === 420)
controller.show()
controller.hide()
check('window-controller: 显示与隐藏', win.calls.at(-2)[0] === 'show' && win.calls.at(-1)[0] === 'hide')

// 5. HostAdapter 能力降级
const bare = createDesktopBridge('2.0.0-dev.0')
check('host: 空接线的能力为 false', bare.capabilities().ask === false)
let hostAskCode = null
try {
  await bare.ask({ id: 'a1', question: '测试' })
} catch (error) {
  hostAskCode = error.code
}
check('host: 空接线 ask 降级 NOT_SUPPORTED', hostAskCode === 'NOT_SUPPORTED')

const wired = createDesktopBridge('2.0.0-dev.0', {
  ask: async (request) => ({ id: request.id, answer: '在的', source: 'pet' }),
  approve: async () => true,
  reportTask: () => {}
})
check('host: 接线后能力为 true', wired.capabilities().ask === true && wired.capabilities().approval === true)
const answer = await wired.ask({ id: 'a2', question: '在吗' })
check('host: ask 正常返回', answer.answer === '在的' && answer.source === 'pet')
check('host: approve 正常返回', (await wired.approve({ id: 'p1', title: '确认', risk: 'low' })) === true)
check('host: describe 含能力标记', wired.describe().includes('ask') && wired.describe().includes('approval'))

const adapter = createHostAdapter('9.9.9')
check('host: 裸适配器版本正确', adapter.version === '9.9.9' && adapter.ask === undefined)

console.log('\nP3_SMOKE_' + (failed === 0 ? 'OK' : 'FAILED_' + failed))
process.exit(failed === 0 ? 0 : 1)
