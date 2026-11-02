import { describe, expect, it, vi } from 'vitest'
import { RendererHost } from '../rendererHost.js'
import { SpriteModel } from '../spriteModel.js'
import type { SpriteSheet } from '@pet/shared'

/* ------------------------------ 测试替身 ------------------------------ */

function fakeImage(): {
  src: string
  complete: boolean
  naturalWidth: number
  naturalHeight: number
  onload: (() => void) | null
  onerror: ((error: unknown) => void) | null
  crossOrigin?: string | null
} {
  return {
    src: '',
    complete: true,
    naturalWidth: 512,
    naturalHeight: 320,
    onload: null,
    onerror: null
  }
}

function fakeCanvas(): HTMLCanvasElement {
  return {
    width: 0,
    height: 0,
    getContext: () => null
  } as unknown as HTMLCanvasElement
}

/** 手动推进的帧调度器，能真实模拟 cancelFrame。 */
class ManualFrames {
  private callbacks = new Map<number, (time: number) => void>()
  private nextHandle = 1
  private clock = 0

  requestFrame = (callback: (time: number) => void): number => {
    const handle = this.nextHandle++
    this.callbacks.set(handle, callback)
    return handle
  }

  cancelFrame = (handle: number): void => {
    this.callbacks.delete(handle)
  }

  now = (): number => this.clock

  get pending(): number {
    return this.callbacks.size
  }

  /** 推进一次：把当前排队的回调全部执行一遍。 */
  step(ms: number): void {
    this.clock += ms
    const queued = [...this.callbacks.entries()]
    this.callbacks.clear()
    for (const [, callback] of queued) callback(this.clock)
  }
}

function fakeEventSource(): {
  addEventListener(type: string, listener: () => void): void
  removeEventListener(type: string, listener: () => void): void
  fire(type: string): void
} {
  const listeners = new Map<string, Set<() => void>>()
  return {
    addEventListener: (type, listener) => {
      const set = listeners.get(type) ?? new Set()
      set.add(listener)
      listeners.set(type, set)
    },
    removeEventListener: (type, listener) => {
      listeners.get(type)?.delete(listener)
    },
    fire: (type) => {
      for (const listener of listeners.get(type) ?? []) listener()
    }
  }
}

/* ------------------------------ 公共夹具 ------------------------------ */

const SHEET: SpriteSheet = {
  image: 'pet/sheet.png',
  grid: { columns: 4, rows: 2, frameWidth: 128, frameHeight: 160 },
  clips: [
    { name: 'idle', startFrame: 0, frameCount: 4, fps: 4, loop: true },
    { name: 'tap', startFrame: 4, frameCount: 3, fps: 4, loop: false }
  ]
}

const PROFILE = { name: 'vertical' as const, w: 600, h: 800, anchor: 'bottom-center' as const }

async function makeModel(): Promise<SpriteModel> {
  const model = new SpriteModel({ id: 'pet', profile: PROFILE, dpr: 1 }, { sheet: SHEET, createImage: fakeImage })
  await model.load({ source: SHEET.image, profile: PROFILE, dpr: 1 })
  model.attach(fakeCanvas())
  return model
}

/* ------------------------------ SpriteModel ------------------------------ */

describe('SpriteModel', () => {
  it('加载后首帧可渲染，默认动作是第一个片段', async () => {
    const model = await makeModel()
    expect(model.isRenderable()).toBe(true)
    expect(model.currentAction).toBe('idle')
    expect(model.currentFrame).toBe(0)
  })

  it('tick 按 fps 推进帧（4fps ⇒ 每 0.25 秒一帧）', async () => {
    const model = await makeModel()
    model.tick(0.24)
    expect(model.currentFrame).toBe(0)
    model.tick(0.01)
    expect(model.currentFrame).toBe(1)
  })

  it('一帧 dt 跨多帧时能追上，不丢帧', async () => {
    const model = await makeModel()
    model.tick(1.0) // 4fps 下约 4 帧
    expect(model.currentFrame).toBe(0) // 循环回起点
  })

  it('非循环动作播完回默认，不卡在末帧', async () => {
    const model = await makeModel()
    model.playAction('tap')
    expect(model.currentAction).toBe('tap')
    model.tick(0.8) // 3 帧 × 0.25s，播完
    expect(model.currentAction).toBe('idle')
  })

  it('pause 后 tick 不推进，resume 后继续且不跳帧', async () => {
    const model = await makeModel()
    model.tick(0.25)
    expect(model.currentFrame).toBe(1)

    model.pause()
    model.tick(5)
    expect(model.currentFrame).toBe(1)

    model.resume()
    model.tick(0.25)
    expect(model.currentFrame).toBe(2)
  })

  it('未知动作抛出稳定错误', async () => {
    const model = await makeModel()
    expect(() => model.playAction('wave')).toThrow(/没有这个动作/)
  })

  it('renderState：未加载 idle → 加载成功 ready → dispose 后 disposed', async () => {
    const model = new SpriteModel({ id: 'pet', profile: PROFILE, dpr: 1 }, { sheet: SHEET, createImage: fakeImage })
    expect(model.renderState).toBe('idle')

    await model.load({ source: SHEET.image, profile: PROFILE, dpr: 1 })
    expect(model.renderState).toBe('ready')

    model.dispose()
    expect(model.renderState).toBe('disposed')
  })

  it('renderState：加载中与失败的都可读写，失败必须落到 failed', async () => {
    let image: ReturnType<typeof fakeImage> | null = null
    const model = new SpriteModel(
      { id: 'pet', profile: PROFILE, dpr: 1 },
      {
        sheet: SHEET,
        createImage: () => {
          image = fakeImage()
          image.complete = false
          return image
        }
      }
    )

    const pending = model.load({ source: 'missing.png', profile: PROFILE, dpr: 1 })
    expect(model.renderState).toBe('loading')

    image!.onerror?.(new Error('404'))
    await expect(pending).rejects.toThrow(/帧序列底图加载失败/)
    expect(model.renderState).toBe('failed')
    expect(model.isRenderable()).toBe(false)
  })

  it('renderState：底图零尺寸算 failed，不退化成静默空白', async () => {
    let image: ReturnType<typeof fakeImage> | null = null
    const model = new SpriteModel(
      { id: 'pet', profile: PROFILE, dpr: 1 },
      {
        sheet: SHEET,
        createImage: () => {
          image = { ...fakeImage(), complete: false, naturalWidth: 0 }
          return image
        }
      }
    )

    const pending = model.load({ source: SHEET.image, profile: PROFILE, dpr: 1 })
    image!.onload?.()

    await expect(pending).rejects.toThrow(/没有有效尺寸/)
    expect(model.renderState).toBe('failed')
    expect(model.isRenderable()).toBe(false)
  })
})

/* ------------------------------ 生命周期绑定 ------------------------------ */

describe('RendererHost.bindLifecycle', () => {
  it('blur 后 rAF 回调不再被调用（关键验收）', async () => {
    const frames = new ManualFrames()
    const host = new RendererHost({ environment: frames })
    const model = await makeModel()
    host.attach(model)
    host.start()

    frames.step(16)
    expect(host.frameCount).toBe(1)

    const windowSource = fakeEventSource()
    const documentSource = { ...fakeEventSource(), hidden: false }
    host.bindLifecycle(windowSource, documentSource)

    windowSource.fire('blur')

    const before = host.frameCount
    frames.step(16)
    frames.step(16)

    expect(host.frameCount).toBe(before)
    expect(frames.pending).toBe(0)
  })

  it('focus 后恢复，且暂停期间的时间不计入', async () => {
    const frames = new ManualFrames()
    const host = new RendererHost({ environment: frames })
    const model = await makeModel()
    host.attach(model)
    host.start()

    const windowSource = fakeEventSource()
    const documentSource = { ...fakeEventSource(), hidden: false }
    host.bindLifecycle(windowSource, documentSource)

    windowSource.fire('blur')
    frames.step(5000) // 暂停期间过去 5 秒
    windowSource.fire('focus')

    // 恢复后第一帧的 dt 从 resume 时刻重新计算，不补这 5 秒
    frames.step(16)
    expect(host.isRunning).toBe(true)
    expect(host.frameCount).toBe(1)
  })

  it('页面隐藏时暂停，可见时恢复', async () => {
    const frames = new ManualFrames()
    const host = new RendererHost({ environment: frames })
    const model = await makeModel()
    host.attach(model)
    host.start()

    const windowSource = fakeEventSource()
    const documentSource = { ...fakeEventSource(), hidden: false }
    host.bindLifecycle(windowSource, documentSource)

    documentSource.hidden = true
    documentSource.fire('visibilitychange')
    expect(host.isRunning).toBe(false)

    documentSource.hidden = false
    documentSource.fire('visibilitychange')
    expect(host.isRunning).toBe(true)
  })

  it('解绑后事件不再影响宿主', async () => {
    const frames = new ManualFrames()
    const host = new RendererHost({ environment: frames })
    const model = await makeModel()
    host.attach(model)
    host.start()

    const windowSource = fakeEventSource()
    const documentSource = { ...fakeEventSource(), hidden: false }
    const unbind = host.bindLifecycle(windowSource, documentSource)
    unbind()

    windowSource.fire('blur')
    expect(host.isRunning).toBe(true)
  })

  it('dispose 后 cancelFrame 已执行，队列为空', async () => {
    const frames = new ManualFrames()
    const host = new RendererHost({ environment: frames })
    const model = await makeModel()
    host.attach(model)
    host.start()

    expect(frames.pending).toBe(1)
    host.dispose()
    expect(frames.pending).toBe(0)
    expect(host.isRunning).toBe(false)
    expect(host.attached).toBeNull()
  })
})
