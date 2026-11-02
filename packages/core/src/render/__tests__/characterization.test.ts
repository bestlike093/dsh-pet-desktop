/**
 * S0 现状特性测试（characterization test）。
 *
 * 目的：在改公共契约之前，把 `attach` / `dispose` / `isRenderable` 的
 * 当前行为锁住。S0 的契约动作完成后，这组测试必须仍然全绿。
 *
 * 注意：`resize(profile)` 目前不在 `IModel` 里，下面的快照断言记录的就是
 * 这个现状。S0 把 resize 补进契约后，把对应断言改为 `true`。
 */
import { describe, expect, it } from 'vitest'
import { SIZE_PROFILES } from '@pet/shared'
import type { EmotionTag, IModel, LoadContext } from '@pet/shared'
import { createImageAdapter, ImageModel } from '../imageAdapter.js'
import type { ImageLike } from '../imageAdapter.js'
import { createGifAdapter } from '../gifAdapter.js'
import { Live2DModel, createLive2DAdapter } from '../live2dAdapter.js'
import { createVideoAdapter, VideoModel } from '../videoAdapter.js'
import type { VideoLike } from '../videoAdapter.js'
import { RendererHost } from '../rendererHost.js'

const profile = SIZE_PROFILES.square
const context = { id: 'test-model', source: 'memory://fixture', profile, dpr: 1 }

function loadContext(source = 'memory://fixture'): LoadContext {
  return { source, profile, dpr: 1 }
}

function fakeImage(width = 128, height = 128): ImageLike {
  return {
    complete: true,
    naturalWidth: width,
    naturalHeight: height,
    crossOrigin: '',
    onload: null,
    onerror: null,
    src: ''
  }
}

function fakeVideo(width = 640, height = 360): VideoLike & { playing: boolean } {
  return {
    src: '',
    readyState: 2,
    videoWidth: width,
    videoHeight: height,
    muted: false,
    loop: false,
    playsInline: false,
    onloadeddata: null,
    onerror: null,
    playing: false,
    async play() {
      this.playing = true
    },
    pause() {
      this.playing = false
    },
    load() {}
  }
}

function fakeCanvas(): HTMLCanvasElement {
  return {
    width: 0,
    height: 0,
    getContext: () => null,
    parentNode: undefined
  } as unknown as HTMLCanvasElement
}

describe('IModel 契约现状快照', () => {
  it('resize 已进入契约（S2 定稿后由「不存在」翻为 true）', () => {
    const model = new ImageModel(context, { createImage: () => fakeImage() })
    expect('resize' in model).toBe(true)
    expect(typeof model.resize).toBe('function')
  })

  it('attach / dispose / isRenderable 已存在', () => {
    const model = new ImageModel(context, { createImage: () => fakeImage() })
    expect(typeof model.attach).toBe('function')
    expect(typeof model.dispose).toBe('function')
    expect(typeof model.isRenderable).toBe('function')
  })
})

describe('ImageModel 生命周期', () => {
  it('load 后可渲染，attach 不抛错', async () => {
    const model = new ImageModel(context, { createImage: () => fakeImage(200, 100) })
    expect(model.isRenderable()).toBe(false)

    await model.load(loadContext())
    expect(model.isRenderable()).toBe(true)
    expect(() => model.attach(fakeCanvas())).not.toThrow()
  })

  it('dispose 幂等：连续两次不抛错', async () => {
    const model = new ImageModel(context, { createImage: () => fakeImage() })
    await model.load(loadContext())

    model.dispose()
    expect(model.isRenderable()).toBe(false)
    expect(() => model.dispose()).not.toThrow()
  })

  it('GIF adapter 复用同一实现，kind 为 gif', () => {
    const adapter = createImageAdapter({ kind: 'gif' })
    const model = adapter.create({ ...context, source: 'memory://fixture.gif' })
    expect(model.kind).toBe('gif')
  })
})

describe('VideoModel 生命周期', () => {
  it('load 后可渲染，dispose 幂等', async () => {
    const video = fakeVideo()
    const model = new VideoModel(context, { createVideo: () => video })
    expect(model.isRenderable()).toBe(false)

    await model.load(loadContext())
    expect(model.isRenderable()).toBe(true)
    expect(video.playing).toBe(true)

    model.dispose()
    expect(model.isRenderable()).toBe(false)
    expect(() => model.dispose()).not.toThrow()
  })

  it('pause / resume 真实反映到 video 元素', async () => {
    const video = fakeVideo()
    const model = new VideoModel(context, { createVideo: () => video })
    await model.load(loadContext())

    model.pause()
    expect(video.playing).toBe(false)
    model.resume()
    expect(video.playing).toBe(true)
  })

  it('外部 tick 是幂等 no-op，不推进播放状态', async () => {
    const video = fakeVideo()
    const model = new VideoModel(context, { createVideo: () => video })
    await model.load(loadContext())

    const before = video.playing
    // VideoModel 的具体签名是 tick(): void；按 IModel 契约调用验证 no-op。
    const contract: IModel = model
    contract.tick(0.016)
    contract.tick(0.016)
    expect(video.playing).toBe(before)
  })
})

describe('RendererHost 外部驱动节奏', () => {
  function makeHost() {
    const queue: Array<(time: number) => void> = []
    const environment = {
      requestFrame: (cb: (time: number) => void) => {
        queue.push(cb)
        return queue.length
      },
      cancelFrame: () => {},
      now: () => 0
    }
    return { host: new RendererHost({ environment }), queue }
  }

  it('attach 后由 host 推进 model.tick', () => {
    const { host, queue } = makeHost()
    const ticks: number[] = []
    const model: IModel = {
      id: 'stub',
      kind: 'image',
      profile,
      async load() {},
      attach() {},
      resize() {},
      tick(dt) {
        ticks.push(dt)
      },
      pause() {},
      resume() {},
      dispose() {},
      isRenderable: () => true
    }

    host.attach(model)
    host.start()
    const frame = queue.shift()
    expect(frame).toBeTypeOf('function')
    frame?.(16)

    expect(ticks).toHaveLength(1)
    expect(ticks[0]).toBeCloseTo(0.016, 5)
    host.pause()
  })

  it('pause 后不再推进帧', () => {
    const { host, queue } = makeHost()
    let count = 0
    const model: IModel = {
      id: 'stub',
      kind: 'image',
      profile,
      async load() {},
      attach() {},
      resize() {},
      tick() {
        count += 1
      },
      pause() {},
      resume() {},
      dispose() {},
      isRenderable: () => true
    }

    host.attach(model)
    host.start()
    queue.shift()?.(16)
    host.pause()
    expect(host.isRunning).toBe(false)
    expect(count).toBe(1)
  })
})

describe('RendererHost.attach / detach 真实现状', () => {
  function makeHost() {
    const queue: Array<(time: number) => void> = []
    const environment = {
      requestFrame: (cb: (time: number) => void) => {
        queue.push(cb)
        return queue.length
      },
      cancelFrame: () => {},
      now: () => 0
    }
    return { host: new RendererHost({ environment }), queue }
  }

  function makeModel(id: string) {
    const state = { paused: 0, resumed: 0, disposed: 0, ticks: 0 }
    const model: IModel = {
      id,
      kind: 'image',
      profile,
      async load() {},
      attach() {},
      resize() {},
      tick() {
        state.ticks += 1
      },
      pause() {
        state.paused += 1
      },
      resume() {
        state.resumed += 1
      },
      dispose() {
        state.disposed += 1
      },
      isRenderable: () => true
    }
    return { model, state }
  }

  it('attach 换模型：旧模型被 pause，frameCount 归零', () => {
    const { host } = makeHost()
    const a = makeModel('a')
    const b = makeModel('b')

    host.attach(a.model)
    host.start()
    host.step(0.016)
    expect(host.frameCount).toBe(1)

    host.attach(b.model)
    expect(a.state.paused).toBe(1)
    expect(host.frameCount).toBe(0)
    expect(host.attached).toBe(b.model)
  })

  it('重复 attach 同一模型：不 pause 自己', () => {
    const { host } = makeHost()
    const a = makeModel('a')
    host.attach(a.model)
    host.attach(a.model)
    expect(a.state.paused).toBe(0)
  })

  it('detach 返回旧模型并 pause，第二次返回 null', () => {
    const { host } = makeHost()
    const a = makeModel('a')
    host.attach(a.model)

    const previous = host.detach()
    expect(previous).toBe(a.model)
    expect(a.state.paused).toBe(1)
    expect(host.attached).toBeNull()
    expect(host.detach()).toBeNull()
  })

  it('detach 后 start 不推进帧', () => {
    const { host } = makeHost()
    const a = makeModel('a')
    host.attach(a.model)
    host.detach()
    host.start()
    expect(host.isRunning).toBe(false)
  })

  it('没有模型时 start / step 都是 no-op', () => {
    const { host } = makeHost()
    host.start()
    host.step(0.016)
    expect(host.frameCount).toBe(0)
  })
})

describe('Live2DModel.attach / dispose 真实现状', () => {
  function makeDelegate() {
    const calls = { ticks: 0, attached: 0, destroyed: 0, expressions: [] as string[] }
    return {
      calls,
      delegate: {
        tick(_dt: number) {
          calls.ticks += 1
        },
        destroy() {
          calls.destroyed += 1
        },
        attachTo(_canvas: HTMLCanvasElement) {
          calls.attached += 1
        },
        setExpression(tag: EmotionTag) {
          calls.expressions.push(tag)
        }
      }
    }
  }

  it('load 后可渲染；attach / tick / setExpression / dispose 转发给 delegate', async () => {
    const { calls, delegate } = makeDelegate()
    const model = new Live2DModel(context, {
      loader: { load: async () => delegate }
    })

    await model.load(loadContext())
    expect(model.isRenderable()).toBe(true)

    model.attach(fakeCanvas())
    expect(calls.attached).toBe(1)

    model.tick(0.016)
    expect(calls.ticks).toBe(1)

    model.setExpression('happy')
    expect(calls.expressions).toEqual(['happy'])

    model.dispose()
    expect(calls.destroyed).toBe(1)
    expect(model.isRenderable()).toBe(false)
  })

  it('dispose 幂等：第二次不重复 destroy', async () => {
    const { calls, delegate } = makeDelegate()
    const model = new Live2DModel(context, { loader: { load: async () => delegate } })
    await model.load(loadContext())
    model.dispose()
    model.dispose()
    expect(calls.destroyed).toBe(1)
  })
})

describe('resize 行为：profile 变更必须真的落到尺寸上', () => {
  function trackedCanvas(): {
    canvas: HTMLCanvasElement
    drawCalls: () => number
    drawArgs: () => number[][]
  } {
    let calls = 0
    const args: number[][] = []
    const canvas = {
      width: 0,
      height: 0,
      parentNode: undefined,
      getContext: () => ({
        clearRect: () => {},
        drawImage: (...input: unknown[]) => {
          calls += 1
          args.push(input.slice(1) as number[])
        }
      })
    }
    return { canvas: canvas as unknown as HTMLCanvasElement, drawCalls: () => calls, drawArgs: () => args }
  }

  it('ImageModel：resize 更新 profile、画布像素尺寸，并重新绘制', async () => {
    const { canvas, drawCalls } = trackedCanvas()
    const model = new ImageModel(context, { createImage: () => fakeImage(200, 100) })
    await model.load(loadContext())
    model.attach(canvas)

    const before = drawCalls()
    model.resize(SIZE_PROFILES.vertical)

    expect(model.profile.name).toBe('vertical')
    expect(canvas.width).toBe(600)
    expect(canvas.height).toBe(800)
    expect(drawCalls()).toBe(before + 1)
  })

  it('ImageModel：绘制按原图比例 contain，不拉满画布', async () => {
    const { canvas, drawArgs } = trackedCanvas()
    const model = new ImageModel(context, { createImage: () => fakeImage(200, 100) })
    await model.load(loadContext())
    model.attach(canvas)
    model.resize(SIZE_PROFILES.vertical)

    const last = drawArgs().at(-1)
    expect(last).toBeDefined()
    if (last === undefined) throw new Error('没有记录到 drawImage 调用')
    const [dx, dy, drawWidth, drawHeight] = last
    if (drawWidth === undefined || drawHeight === undefined) throw new Error('drawImage 参数不完整')
    expect(drawWidth / drawHeight).toBeCloseTo(2, 5)
    expect(drawWidth).toBe(600)
    expect(drawHeight).toBe(300)
    expect(dx).toBe(0)
    expect(dy).toBe(250)
  })

  it('GIF adapter 复用同一实现，resize 同样生效', async () => {
    const { canvas } = trackedCanvas()
    const model = createGifAdapter({ createImage: () => fakeImage(200, 100) }).create({
      ...context,
      source: 'memory://fixture.gif'
    })
    await model.load(loadContext('memory://fixture.gif'))
    model.attach(canvas)

    model.resize(SIZE_PROFILES.card)

    expect(model.kind).toBe('gif')
    expect(model.profile.name).toBe('card')
    expect(canvas.width).toBe(380)
    expect(canvas.height).toBe(240)
  })

  it('VideoModel：resize 只改布局，不重启 video、不重置播放进度', async () => {
    const { canvas } = trackedCanvas()
    let loadCalls = 0
    let playCalls = 0
    const video: VideoLike & { playing: boolean } = {
      src: '',
      readyState: 0,
      videoWidth: 640,
      videoHeight: 360,
      muted: false,
      loop: false,
      playsInline: false,
      onloadeddata: null,
      onerror: null,
      playing: false,
      async play() {
        playCalls += 1
        this.playing = true
      },
      pause() {
        this.playing = false
      },
      load() {
        loadCalls += 1
      }
    }
    const model = new VideoModel(context, { createVideo: () => video })
    const pending = model.load(loadContext())
    expect(loadCalls).toBe(1)
    expect(video.src).toBe('memory://fixture')

    const fireLoaded = video.onloadeddata
    video.readyState = 2
    fireLoaded?.()
    await pending
    model.attach(canvas)

    expect(loadCalls).toBe(1)
    expect(playCalls).toBe(1)
    expect(video.playing).toBe(true)

    model.resize(SIZE_PROFILES.vertical)

    expect(model.profile.name).toBe('vertical')
    expect(canvas.width).toBe(600)
    expect(canvas.height).toBe(800)
    expect(loadCalls).toBe(1)
    expect(playCalls).toBe(1)
    expect(video.src).toBe('memory://fixture')
    expect(video.playing).toBe(true)
  })

  it('Live2D 降级分支：resize 转给 fallback，并真的改到画布', async () => {
    const { canvas } = trackedCanvas()
    const model = new Live2DModel(context, {
      loader: {
        load: async () => {
          throw new Error('load failed')
        }
      },
      fallback: createImageAdapter({ createImage: () => fakeImage(200, 100) })
    })
    await model.load(loadContext())
    model.attach(canvas)

    model.resize(SIZE_PROFILES.horizontal)

    expect(model.usingFallback).toBe(true)
    expect(model.profile.name).toBe('horizontal')
    expect(canvas.width).toBe(800)
    expect(canvas.height).toBe(450)
  })

  it('dispose 后 resize 是幂等 no-op', async () => {
    const model = new ImageModel(context, { createImage: () => fakeImage() })
    await model.load(loadContext())
    model.dispose()
    expect(() => model.resize(SIZE_PROFILES.vertical)).not.toThrow()
  })

  it('VideoModel：尺寸门在 HAVE_METADATA 打开，首帧门在 HAVE_CURRENT_DATA 才开', async () => {
    const { canvas } = trackedCanvas()
    let loadCalls = 0
    const video: VideoLike = {
      src: '',
      readyState: 0,
      videoWidth: 640,
      videoHeight: 360,
      muted: false,
      loop: false,
      playsInline: false,
      onloadedmetadata: null,
      onloadeddata: null,
      onerror: null,
      async play() {},
      pause() {},
      load() {
        loadCalls += 1
      }
    }
    const model = new VideoModel(context, { createVideo: () => video })
    model.attach(canvas)

    // 启动期 resize：元数据还没到，不能丢，先挂起
    model.resize(SIZE_PROFILES.vertical)
    expect(model.profile.name).toBe('vertical')
    expect(canvas.width).toBe(0)
    expect(canvas.height).toBe(0)

    const pending = model.load(loadContext())
    expect(loadCalls).toBe(1)

    // 元数据到：尺寸立即落，但还没有首帧
    const fireMetadata = video.onloadedmetadata
    video.readyState = 1
    fireMetadata?.()
    expect(canvas.width).toBe(600)
    expect(canvas.height).toBe(800)
    expect(model.isRenderable()).toBe(false)

    // 首帧到：才可渲染
    const fireLoaded = video.onloadeddata
    video.readyState = 2
    fireLoaded?.()
    await pending
    expect(model.isRenderable()).toBe(true)
  })

  it('VideoModel：HAVE_METADATA 时 resize 立即应用，不必等 loadeddata', async () => {
    const { canvas } = trackedCanvas()
    const video: VideoLike = {
      src: '',
      readyState: 0,
      videoWidth: 640,
      videoHeight: 360,
      muted: false,
      loop: false,
      playsInline: false,
      onloadedmetadata: null,
      onloadeddata: null,
      onerror: null,
      async play() {},
      pause() {},
      load() {}
    }
    const model = new VideoModel(context, { createVideo: () => video })
    model.attach(canvas)
    const pending = model.load(loadContext())

    const fireMetadata = video.onloadedmetadata
    video.readyState = 1
    fireMetadata?.()

    model.resize(SIZE_PROFILES.horizontal)

    expect(model.profile.name).toBe('horizontal')
    expect(canvas.width).toBe(800)
    expect(canvas.height).toBe(450)
    // 只有元数据、没有首帧：诊断仍判黑屏
    expect(model.isRenderable()).toBe(false)

    const fireLoaded = video.onloadeddata
    video.readyState = 2
    fireLoaded?.()
    await pending
  })

  it('VideoModel：dispose 后派发旧的 loadedmetadata / loadeddata 不再动 canvas', async () => {
    const { canvas } = trackedCanvas()
    const video: VideoLike = {
      src: '',
      readyState: 0,
      videoWidth: 640,
      videoHeight: 360,
      muted: false,
      loop: false,
      playsInline: false,
      onloadedmetadata: null,
      onloadeddata: null,
      onerror: null,
      async play() {},
      pause() {},
      load() {}
    }
    const model = new VideoModel(context, { createVideo: () => video })
    model.attach(canvas)
    void model.load(loadContext())

    const staleMetadata = video.onloadedmetadata
    const staleLoaded = video.onloadeddata
    expect(typeof staleMetadata).toBe('function')
    expect(typeof staleLoaded).toBe('function')

    model.dispose()
    expect(video.onloadedmetadata).toBeNull()
    expect(video.onloadeddata).toBeNull()

    // 模拟元素仍向已释放对象派发旧闭包
    video.readyState = 2
    expect(() => {
      staleMetadata?.()
      staleLoaded?.()
    }).not.toThrow()
    expect(canvas.width).toBe(0)
    expect(canvas.height).toBe(0)
    expect(model.isRenderable()).toBe(false)
  })

  it('VideoModel：换源重走门槛，pendingProfile 保留并按当前 profile 落尺寸', async () => {
    const { canvas } = trackedCanvas()
    const videos: VideoLike[] = []
    const model = new VideoModel(context, {
      createVideo: () => {
        const video: VideoLike = {
          src: '',
          readyState: 0,
          videoWidth: 640,
          videoHeight: 360,
          muted: false,
          loop: false,
          playsInline: false,
          onloadedmetadata: null,
          onloadeddata: null,
          onerror: null,
          async play() {},
          pause() {},
          load() {}
        }
        videos.push(video)
        return video
      }
    })
    model.attach(canvas)

    const first = model.load(loadContext('memory://first'))
    videos[0]!.readyState = 1
    videos[0]!.onloadedmetadata?.()
    videos[0]!.readyState = 2
    videos[0]!.onloadeddata?.()
    await first
    expect(canvas.width).toBe(512)
    expect(model.isRenderable()).toBe(true)

    // 换源前切 profile：新 profile 进入待应用状态
    model.resize(SIZE_PROFILES.card)
    expect(canvas.width).toBe(380)

    // 换源瞬间：可渲染判定立即失效，新源重新从门槛 0 开始
    const second = model.load(loadContext('memory://second'))
    expect(videos).toHaveLength(2)
    expect(model.isRenderable()).toBe(false)

    // 新源 metadata 到达：pendingProfile 仍在，按 card 重算
    videos[1]!.readyState = 1
    videos[1]!.onloadedmetadata?.()
    expect(canvas.width).toBe(380)
    expect(canvas.height).toBe(240)
    expect(canvas.width).not.toBe(512)

    videos[1]!.readyState = 2
    videos[1]!.onloadeddata?.()
    await second
    expect(model.isRenderable()).toBe(true)
  })

  it('VideoModel：只收到 loadeddata 时也能补上布局', async () => {
    const { canvas } = trackedCanvas()
    const video: VideoLike = {
      src: '',
      readyState: 0,
      videoWidth: 640,
      videoHeight: 360,
      muted: false,
      loop: false,
      playsInline: false,
      onloadedmetadata: null,
      onloadeddata: null,
      onerror: null,
      async play() {},
      pause() {},
      load() {}
    }
    const model = new VideoModel(context, { createVideo: () => video })
    model.attach(canvas)
    model.resize(SIZE_PROFILES.vertical)
    const pending = model.load(loadContext())

    // 跳过 metadata 事件，直接派发首帧
    const fireLoaded = video.onloadeddata
    video.readyState = 2
    fireLoaded?.()
    await pending

    expect(canvas.width).toBe(600)
    expect(canvas.height).toBe(800)
    expect(model.isRenderable()).toBe(true)
  })

  it('四个 adapter 在 dispose 后调用 resize / tick / setExpression 都是 no-op', async () => {
    const adapters = [
      { name: 'image', adapter: createImageAdapter({ createImage: () => fakeImage() }) },
      { name: 'gif', adapter: createGifAdapter({ createImage: () => fakeImage() }) },
      { name: 'video', adapter: createVideoAdapter({ createVideo: () => fakeVideo() }) },
      {
        name: 'live2d',
        adapter: createLive2DAdapter({
          loader: {
            load: async () => {
              throw new Error('force fallback')
            }
          },
          fallback: createImageAdapter({ createImage: () => fakeImage() })
        })
      }
    ] as const

    for (const { name, adapter } of adapters) {
      const model = adapter.create({ ...context, source: `memory://${name}` })
      await model.load(loadContext(`memory://${name}`))
      model.dispose()

      expect(
        () => {
          model.resize(SIZE_PROFILES.vertical)
          model.tick(0.016)
          model.setExpression?.('happy')
          model.pause()
          model.resume()
        },
        `${name} dispose 后不应抛错`
      ).not.toThrow()
    }
  })

  it('GIF adapter 复用同一实现：创建出的实例就是 ImageModel', () => {
    const model = createGifAdapter({ createImage: () => fakeImage() }).create({
      ...context,
      source: 'memory://fixture.gif'
    })
    expect(model).toBeInstanceOf(ImageModel)
    expect(model.kind).toBe('gif')
  })

  it('Live2D 降级：host.resize 穿透到 delegate 并实际改尺寸', async () => {
    const queue: Array<(time: number) => void> = []
    const host = new RendererHost({
      environment: {
        requestFrame: (cb) => {
          queue.push(cb)
          return queue.length
        },
        cancelFrame: () => {},
        now: () => 0
      }
    })
    const { canvas } = trackedCanvas()
    const model = new Live2DModel(context, {
      loader: {
        load: async () => {
          throw new Error('force fallback')
        }
      },
      fallback: createImageAdapter({ createImage: () => fakeImage(200, 100) })
    })
    await model.load(loadContext())
    model.attach(canvas)
    host.attach(model)

    host.resize(SIZE_PROFILES.horizontal)

    expect(model.usingFallback).toBe(true)
    expect(model.profile.name).toBe('horizontal')
    expect(canvas.width).toBe(800)
    expect(canvas.height).toBe(450)
  })
})
