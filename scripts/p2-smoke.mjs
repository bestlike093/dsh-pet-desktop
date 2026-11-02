// P2 冒烟：渲染抽象与适配器，使用替身画布，不依赖真实浏览器
import {
  AdapterRegistry,
  RendererHost,
  createGifAdapter,
  createImageAdapter,
  createLive2DAdapter,
  createVideoAdapter
} from '../packages/core/dist/index.js'
import { SIZE_PROFILES } from '../packages/shared/dist/index.js'

let failed = 0
function check(name, ok, extra = '') {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : ''))
  if (!ok) failed += 1
}

const context = {
  id: 'm1',
  source: 'assets/pet.png',
  profile: SIZE_PROFILES.vertical,
  dpr: 2
}
const loadContext = { source: 'assets/pet.png', profile: SIZE_PROFILES.vertical, dpr: 2 }

function fakeImage(width = 100, height = 200) {
  return {
    src: '',
    complete: true,
    naturalWidth: width,
    naturalHeight: height,
    onload: null,
    onerror: null,
    crossOrigin: null
  }
}

function fakeCanvas() {
  return {
    width: 600,
    height: 800,
    getContext: () => null,
    parentNode: null
  }
}

// 1. 适配器注册表
const empty = new AdapterRegistry()
let missingCode = null
try {
  empty.create('image', context)
} catch (error) {
  missingCode = error.code
}
check('adapter: 未注册类型报 MODEL_NOT_RENDERABLE', missingCode === 'MODEL_NOT_RENDERABLE')

const registry = new AdapterRegistry()
registry.register(createImageAdapter({ createImage: () => fakeImage() }))
registry.register(createGifAdapter({ createImage: () => fakeImage() }))
registry.register(
  createVideoAdapter({
    createVideo: () => ({
      src: '',
      readyState: 3,
      videoWidth: 320,
      videoHeight: 240,
      muted: false,
      loop: false,
      onloadeddata: null,
      onerror: null,
      async play() {},
      pause() {},
      load() {}
    })
  })
)
registry.register(createLive2DAdapter())
check('adapter: 四种适配器注册成功', registry.kinds().length === 4 && registry.has('live2d'))

let duplicateCode = null
try {
  registry.register(createImageAdapter())
} catch (error) {
  duplicateCode = error.code
}
check('adapter: 重复注册被拒', duplicateCode === 'INVALID_ARGUMENT')
registry.register(createImageAdapter({ createImage: () => fakeImage() }), { replace: true })
check('adapter: replace 允许覆盖', registry.has('image') === true)

// 2. 位图模型
const image = registry.create('image', context)
await image.load(loadContext)
check('image: 加载后可渲染', image.isRenderable() === true)
image.tick(0.5)
check('image: tick 推进时间', Math.abs(image.elapsedSeconds - 0.5) < 1e-9)
image.pause()
image.tick(1)
check('image: pause 后不推进', Math.abs(image.elapsedSeconds - 0.5) < 1e-9)
image.resume()
image.tick(0.25)
check('image: resume 后继续推进', Math.abs(image.elapsedSeconds - 0.75) < 1e-9)
image.attach(fakeCanvas())
image.dispose()
check('image: dispose 后不可渲染', image.isRenderable() === false)
check('image: dispose 幂等', (image.dispose(), image.isRenderable() === false))

// 3. GIF 沿用位图实现但保留自己的 kind
const gif = registry.create('gif', context)
await gif.load(loadContext)
check('gif: kind 保持为 gif', gif.kind === 'gif' && gif.isRenderable() === true)
gif.dispose()

// 4. 视频模型
const video = registry.create('video', context)
await video.load(loadContext)
check('video: 加载后可渲染', video.isRenderable() === true)
video.pause()
check('video: pause 状态', video.isPaused === true)
video.resume()
check('video: resume 状态', video.isPaused === false)
video.dispose()
check('video: dispose 后不可渲染', video.isRenderable() === false)

// 5. 渲染宿主：节奏控制
let pending = null
const environment = {
  requestFrame: (callback) => {
    pending = callback
    return 1
  },
  cancelFrame: () => {
    pending = null
  },
  now: () => 0
}

const ticks = []
const fakeModel = {
  id: 'fake',
  kind: 'image',
  profile: SIZE_PROFILES.vertical,
  async load() {},
  attach() {},
  tick(dt) {
    ticks.push(dt)
  },
  pause() {},
  resume() {},
  dispose() {},
  isRenderable: () => true
}

const host = new RendererHost({ environment, maxDelta: 0.05 })
check('renderer: 未挂载不能启动', (host.start(), host.isRunning === false))
host.attach(fakeModel)
host.start()
check('renderer: 启动后进入运行态', host.isRunning === true && pending !== null)
pending(1000)
check('renderer: 单帧步长被夹到 maxDelta', ticks.length === 1 && ticks[0] === 0.05)
host.pause()
check('renderer: pause 停止调度', host.isRunning === false && pending === null)
host.resume()
check('renderer: resume 重新调度', host.isRunning === true && pending !== null)
host.step(0.02)
check('renderer: step 手动推进一帧', ticks.length === 2 && ticks[1] === 0.02)
check('renderer: detach 返回旧模型', host.detach() === fakeModel && host.attached === null)
host.stop()

// 6. Live2D：成功后正常转发
let live2dTicks = 0
let destroyed = false
const okLive2D = createLive2DAdapter({
  loader: {
    async load() {
      return {
        tick(dt) {
          live2dTicks += dt
        },
        destroy() {
          destroyed = true
        }
      }
    }
  }
})
const live = okLive2D.create(context)
await live.load(loadContext)
check('live2d: 加载成功可渲染', live.isRenderable() === true && live.usingFallback === false)
live.tick(0.5)
check('live2d: tick 转发', live2dTicks === 0.5)
live.dispose()
check('live2d: dispose 释放底层模型', destroyed === true)

// 7. Live2D：失败降级到静态图
const fallbackLive2D = createLive2DAdapter({
  loader: {
    async load() {
      throw new Error('cubism core missing')
    }
  },
  fallback: createImageAdapter({ createImage: () => fakeImage() })
})
const degraded = fallbackLive2D.create(context)
await degraded.load(loadContext)
check('live2d: 加载失败自动降级', degraded.usingFallback === true && degraded.isRenderable() === true)
degraded.dispose()
check('live2d: 降级模型可正常释放', degraded.isRenderable() === false)

// 8. Live2D：无 fallback 时抛出稳定错误
const strictLive2D = createLive2DAdapter({
  loader: {
    async load() {
      throw new Error('boom')
    }
  }
})
let live2dCode = null
try {
  await strictLive2D.create(context).load(loadContext)
} catch (error) {
  live2dCode = error.code
}
check('live2d: 无降级时报 MODEL_LOAD_FAILED', live2dCode === 'MODEL_LOAD_FAILED')

console.log('\nP2_SMOKE_' + (failed === 0 ? 'OK' : 'FAILED_' + failed))
process.exit(failed === 0 ? 0 : 1)
