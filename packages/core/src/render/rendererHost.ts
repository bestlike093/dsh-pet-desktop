import type { IModel, SizeProfile } from '@pet/shared'

export interface RenderEnvironment {
  readonly requestFrame: (callback: (time: number) => void) => number
  readonly cancelFrame: (handle: number) => void
  readonly now: () => number
}

/** 浏览器优先 requestAnimationFrame，Node/测试环境退化为 16ms 定时器。 */
export function createRenderEnvironment(): RenderEnvironment {
  const g = globalThis as unknown as {
    requestAnimationFrame?: (cb: (time: number) => void) => number
    cancelAnimationFrame?: (handle: number) => void
  }

  if (typeof g.requestAnimationFrame === 'function' && typeof g.cancelAnimationFrame === 'function') {
    return {
      requestFrame: (callback) => g.requestAnimationFrame!(callback),
      cancelFrame: (handle) => g.cancelAnimationFrame!(handle),
      now: () => Date.now()
    }
  }

  return {
    requestFrame: (callback) => Number(setTimeout(() => callback(Date.now()), 16)),
    cancelFrame: (handle) => clearTimeout(handle),
    now: () => Date.now()
  }
}

export interface RendererHostOptions {
  readonly environment?: RenderEnvironment
  /** 单帧最大步长（秒），防止后台切回时一次性补太多帧 */
  readonly maxDelta?: number
}

/** 只取事件订阅能力，避免把 DOM 类型带进纯逻辑层。 */
export interface EventSourceLike {
  addEventListener(type: string, listener: () => void): void
  removeEventListener(type: string, listener: () => void): void
}

export interface DocumentSourceLike extends EventSourceLike {
  readonly hidden: boolean
}

/**
 * 渲染宿主：只负责节奏与生命周期，不认识具体模型格式。
 * 适配器负责画，宿主负责何时画、何时停。
 */
export class RendererHost {
  private readonly environment: RenderEnvironment
  private readonly maxDelta: number
  private model: IModel | null = null
  private handle: number | null = null
  private lastTime: number | null = null
  private frames = 0
  private running = false

  constructor(options: RendererHostOptions = {}) {
    this.environment = options.environment ?? createRenderEnvironment()
    this.maxDelta = options.maxDelta ?? 0.1
  }

  get isRunning(): boolean {
    return this.running
  }

  get frameCount(): number {
    return this.frames
  }

  get attached(): IModel | null {
    return this.model
  }

  attach(model: IModel): void {
    if (this.model !== null && this.model !== model) this.model.pause()
    this.model = model
    this.frames = 0
    this.lastTime = null
  }

  detach(): IModel | null {
    const previous = this.model
    this.model = null
    this.lastTime = null
    if (previous !== null) previous.pause()
    return previous
  }

  /**
   * 广播布局变更给当前模型。
   * 只转发 resize，不暂停、不重启播放，由适配器自行处理进度保持。
   */
  resize(profile: SizeProfile): void {
    this.model?.resize(profile)
  }

  start(): void {
    if (this.running || this.model === null) return
    this.running = true
    this.lastTime = this.environment.now()
    this.schedule()
  }

  pause(): void {
    if (!this.running) return
    this.running = false
    this.cancelScheduled()
    this.model?.pause()
  }

  resume(): void {
    if (this.running || this.model === null) return
    this.model.resume()
    this.start()
  }

  stop(): void {
    this.pause()
    this.model?.pause()
  }

  /**
   * 接真实页面事件：失焦 / 页面隐藏 ⇒ 暂停；回来 ⇒ 续播。
   *
   * 只暴露 `pause()` 而不订阅事件的实现，在内测里会表现为「窗口切走了还在跑」，
   * 被当成性能问题报回来。返回解绑函数，交给持有方在销毁时调用。
   */
  bindLifecycle(windowSource: EventSourceLike, documentSource: DocumentSourceLike): () => void {
    const onBlur = (): void => this.pause()
    const onFocus = (): void => this.resume()
    const onVisibility = (): void => {
      if (documentSource.hidden) this.pause()
      else this.resume()
    }

    windowSource.addEventListener('blur', onBlur)
    windowSource.addEventListener('focus', onFocus)
    documentSource.addEventListener('visibilitychange', onVisibility)

    return (): void => {
      windowSource.removeEventListener('blur', onBlur)
      windowSource.removeEventListener('focus', onFocus)
      documentSource.removeEventListener('visibilitychange', onVisibility)
    }
  }

  /** 释放：先停帧，再断开模型。事件解绑由 bindLifecycle 的返回值负责。 */
  dispose(): void {
    this.running = false
    this.cancelScheduled()
    this.model = null
    this.lastTime = null
  }

  private schedule(): void {
    this.handle = this.environment.requestFrame((time) => this.tick(time))
  }

  private cancelScheduled(): void {
    if (this.handle === null) return
    this.environment.cancelFrame(this.handle)
    this.handle = null
  }

  private tick(time: number): void {
    if (!this.running || this.model === null) return
    const last = this.lastTime ?? time
    const rawDelta = (time - last) / 1000
    const delta = Math.min(this.maxDelta, Math.max(0, rawDelta))
    this.lastTime = time

    this.model.tick(delta)
    this.frames += 1
    this.schedule()
  }

  /** 测试用：让宿主手动推进一帧，不依赖真实定时器。 */
  step(deltaSeconds: number): void {
    if (!this.running || this.model === null) return
    this.model.tick(Math.min(this.maxDelta, Math.max(0, deltaSeconds)))
    this.frames += 1
  }
}
