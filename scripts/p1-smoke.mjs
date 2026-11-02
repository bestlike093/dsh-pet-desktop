// P1 冒烟：运行时核心，纯逻辑，不依赖 Electron / 浏览器
import {
  MemoryStorage,
  ModuleHost,
  PetalRegistry,
  PermissionBroker,
  PetStateMachine,
  Scheduler,
  SettingsStore,
  backoffDelay,
  createDisposerRegistry
} from '../packages/core/dist/index.js'

let failed = 0
function check(name, ok, extra = '') {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : ''))
  if (!ok) failed += 1
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// 1. 状态机
const machine = new PetStateMachine('idle', () => 1000)
const seen = []
const off = machine.onChange((change) => seen.push(`${change.from}->${change.to}`))
const change = machine.transition('talking')
check('state: idle → talking 成功', change.from === 'idle' && change.to === 'talking' && change.at === 1000)
check('state: 监听器收到转移', seen.length === 1 && seen[0] === 'idle->talking')
machine.transition('dragging')
let illegalCode = null
try {
  machine.transition('thinking')
} catch (error) {
  illegalCode = error.code
}
check('state: dragging → thinking 非法', illegalCode === 'INVALID_ARGUMENT')
check('state: 非法转移不改状态', machine.state === 'dragging')
check('state: tryTransition 不抛错', machine.tryTransition('thinking') === null)
off()
machine.transition('idle')
check('state: 取消监听后不再收到', seen.length === 2)

let unknownState = null
try {
  machine.transition('dancing')
} catch (error) {
  unknownState = error.code
}
check('state: 未知状态被拒绝', unknownState === 'INVALID_ARGUMENT')

// 2. 调度器
check('scheduler: 退避第 1 次', backoffDelay(1) === 250)
check('scheduler: 退避翻倍', backoffDelay(3) === 1000)
check('scheduler: 退避封顶', backoffDelay(20) === 30_000)

const scheduler = new Scheduler()
let fired = 0
const taskId = scheduler.schedule(5, () => {
  fired += 1
})
check('scheduler: 任务已登记', scheduler.size === 1)
check('scheduler: 取消成功', scheduler.cancel(taskId) === true)
check('scheduler: 取消后表为空', scheduler.size === 0)
await sleep(20)
check('scheduler: 取消后不执行', fired === 0)
check('scheduler: 重复取消返回 false', scheduler.cancel(taskId) === false)

let ran = 0
scheduler.schedule(1, () => {
  ran += 1
})
await sleep(20)
check('scheduler: 到点执行', ran === 1)
scheduler.clear()

let timeoutCode = null
try {
  await scheduler.runWithTimeout(() => new Promise(() => {}), 10)
} catch (error) {
  timeoutCode = error.code
}
check('scheduler: 超时抛 MODULE_TIMEOUT', timeoutCode === 'LOAD_TIMEOUT')
check('scheduler: 正常任务返回原值', (await scheduler.runWithTimeout(async () => 42, 50)) === 42)

// 3. 设置存储
const storage = new MemoryStorage()
const store = new SettingsStore(storage)
const emptyLoad = await store.load()
check('settings-store: 空存储用默认值', emptyLoad.ok === true && emptyLoad.value.nickname === '')

const saveV1 = await store.save({ schemaVersion: 1, nickname: '小鹿', scale: 1.2, font: 22 })
check('settings-store: 保存时自动迁移', saveV1.ok === true && saveV1.value.window.scale === 1.2)
check('settings-store: 已落盘', storage.size() === 1)

const reloaded = await new SettingsStore(storage).load()
check(
  'settings-store: 重新读取仍是 v2',
  reloaded.ok === true && reloaded.value.nickname === '小鹿' && reloaded.value.bubble.fontSize === 22
)

const badStore = new SettingsStore({
  async read() {
    return '{ not json'
  },
  async write() {
    throw new Error('should not write')
  }
})
const badLoad = await badStore.load()
check(
  'settings-store: 坏 JSON 保留默认值',
  badLoad.ok === false && badLoad.error.code === 'INVALID_ARGUMENT' && badLoad.value.nickname === ''
)

const before = store.get()
const badSave = await store.save({ schemaVersion: 99 })
check(
  'settings-store: 迁移失败不落盘也不改内存',
  badSave.ok === false && store.get() === before && storage.size() === 1
)

const updated = await store.update({ soundLevel: 0.9 })
check(
  'settings-store: update 浅合并',
  updated.ok === true && updated.value.soundLevel === 0.9 && updated.value.nickname === '小鹿'
)

// 4. 模块注册表
const registry = new PetalRegistry()
const disposers = createDisposerRegistry()
let disposed = 0
disposers.add(() => {
  disposed += 1
})
disposers.disposeAll()
check('disposers: 统一释放', disposed === 1)

const makeModule = (id, permissions = [], hooks = {}) => ({
  meta: { id, name: id, version: '1.0.0', permissions },
  async bootstrap(ctx) {
    ctx.disposers.add(() => {
      disposed += 1
    })
    if (hooks.boot) await hooks.boot(ctx)
  },
  async teardown() {
    if (hooks.teardown) await hooks.teardown()
  }
})

const okModule = makeModule('ok', ['ui.render'])
const unregister = registry.register(okModule)
check('registry: 注册成功', registry.has('ok') === true && registry.size === 1)
let duplicateCode = null
try {
  registry.register(okModule)
} catch (error) {
  duplicateCode = error.code
}
check('registry: 重复 id 被拒', duplicateCode === 'INVALID_ARGUMENT')
check('registry: list 带 id', registry.list()[0].id === 'ok')

// 5. 模块宿主：正常 / 抛错 / 越权 / 超时
const permissions = new PermissionBroker(['ui.render'])
const host = new ModuleHost(registry, permissions, {
  root: { querySelector: () => null },
  timeoutMs: 50
})

const booted = await host.start('ok')
check('module-host: 正常模块启动', booted === true)
check('module-host: 状态为 ready', host.statuses()[0].status === 'ready')

const boomModule = makeModule('boom', ['ui.render'], {
  boot: async () => {
    throw new Error('boom')
  }
})
registry.register(boomModule)
const boomStarted = await host.start('boom')
check('module-host: 抛错模块不拖垮宿主', boomStarted === false)
const boomStatus = host.statuses().find((item) => item.id === 'boom')
check('module-host: 失败模块记录错误码', boomStatus.status === 'failed' && boomStatus.code === 'LOAD_FAILED')

const deniedModule = makeModule('denied', ['net.egress'])
registry.register(deniedModule)
const deniedStarted = await host.start('denied')
const deniedStatus = host.statuses().find((item) => item.id === 'denied')
check(
  'module-host: 缺权限被拒',
  deniedStarted === false && deniedStatus.code === 'PERMISSION_DENIED'
)

const slowModule = makeModule('slow', [], {
  boot: () => new Promise(() => {})
})
registry.register(slowModule)
const slowStarted = await host.start('slow')
const slowStatus = host.statuses().find((item) => item.id === 'slow')
check('module-host: 超时模块失败', slowStarted === false && slowStatus.code === 'LOAD_TIMEOUT')
check('module-host: 正常模块不受影响', host.statuses().find((item) => item.id === 'ok').status === 'ready')

const stopped = await host.stop('ok')
check('module-host: 停止模块', stopped === true && host.statuses().find((item) => item.id === 'ok').status === 'stopped')
check('module-host: 重复停止幂等', (await host.stop('ok')) === true)
check('module-host: 停止时释放 disposer', disposed >= 2)

await host.stopAll()
check('module-host: stopAll 全部停止', host.statuses().every((item) => item.status === 'stopped'))
check('module-host: describe 可读', host.describe().includes('ok=stopped'))
check('registry: 注销函数生效', (unregister(), registry.has('ok') === false))

console.log('\nP1_SMOKE_' + (failed === 0 ? 'OK' : 'FAILED_' + failed))
process.exit(failed === 0 ? 0 : 1)
