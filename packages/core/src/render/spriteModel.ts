/**
 * 帧序列模型（B2-2）。
 *
 * 只做「一个当前动作 + 播完回默认」这一层，不建状态机、不建转换表。
 * 时间推进统一走 `tick(dt)`，dt 单位是秒 —— 与 RendererHost 的口径一致。
 *
 * 绘制按 `startFrame + frameIndex` 算行列，行优先。
 */
import { ErrorCode, PetError } from '@pet/shared'
import type { IModel, LoadContext, ModelKind, SizeProfile, SpriteSheet, SpriteSheetClip } from '@pet/shared'
import type { ImageLike } from './imageAdapter.js'

export interface SpriteModelOptions {
  readonly sheet: SpriteSheet
  readonly createImage?: () => ImageLike
  /** 默认动作名；缺省用 clips 的第一个。 */
  readonly defaultAction?: string
}

/**
 * 渲染状态（B2-4）。
 *
 * 空白画布不可接受：加载失败必须能被上层读到。
 * `isRenderable() === false` 只说「画不出来」，说不出「该不该提示」；
 * `'failed'` 就是那个可断言的信号。
 */
export type SpriteRenderState = 'idle' | 'loading' | 'ready' | 'failed' | 'disposed'

function defaultCreateImage(): ImageLike {
  const g = globalThis as unknown as { document?: Document }
  if (g.document === undefined) {
    throw new PetError(ErrorCode.MODEL_LOAD_FAILED, '当前环境没有 document，无法加载位图')
  }
  return g.document.createElement('img') as unknown as ImageLike
}

export class SpriteModel implements IModel {
  readonly id: string
  readonly kind: ModelKind = 'sprite'
  profile: SizeProfile

  private readonly sheet: SpriteSheet
  private readonly clips: ReadonlyMap<string, SpriteSheetClip>
  private readonly defaultAction: string
  private readonly createImage: () => ImageLike
  private readonly dpr: number
  private image: ImageLike | null = null
  private canvas: HTMLCanvasElement | null = null

  private action: SpriteSheetClip
  private frameIndex = 0
  private frameElapsed = 0
  private loaded = false
  private loadFailed = false
  private paused = false
  private disposed = false

  constructor(
    context: { readonly id: string; readonly profile: SizeProfile; readonly dpr?: number },
    options: SpriteModelOptions
  ) {
    this.id = context.id
    this.profile = context.profile
    this.dpr = context.dpr ?? 1
    this.sheet = options.sheet
    this.createImage = options.createImage ?? defaultCreateImage

    const map = new Map<string, SpriteSheetClip>()
    for (const clip of options.sheet.clips) map.set(clip.name, clip)
    this.clips = map

    const first = options.sheet.clips[0]
    if (first === undefined) {
      throw new PetError(ErrorCode.INVALID_ARGUMENT, '帧序列没有任何片段，无法播放')
    }
    this.defaultAction = options.defaultAction ?? first.name
    this.action = map.get(this.defaultAction) ?? first
  }

  get currentAction(): string {
    return this.action.name
  }

  /** 当前帧在整张图里的绝对索引，供诊断与命中测试使用。 */
  get currentFrame(): number {
    return this.action.startFrame + this.frameIndex
  }

  get isPaused(): boolean {
    return this.paused
  }

  /**
   * 渲染状态（B2-4）。
   *
   * `'failed'` 表示加载确实失败过，上层必须显示降级提示，不能留空白。
   * 注意它与 `'loading'` 的区别：两者 `isRenderable()` 都是 false，
   * 只有这里能区分「还在等」和「已经确定看不到」。
   */
  get renderState(): SpriteRenderState {
    if (this.disposed) return 'disposed'
    if (this.loadFailed) return 'failed'
    if (this.loaded) return this.isRenderable() ? 'ready' : 'failed'
    return this.image === null ? 'idle' : 'loading'
  }

  async load(loadContext: LoadContext): Promise<void> {
    if (this.disposed) throw new PetError(ErrorCode.MODEL_LOAD_FAILED, '模型已释放')
    this.loadFailed = false

    const image = this.createImage()
    image.crossOrigin = 'anonymous'
    this.image = image

    await new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        image.onload = null
        image.onerror = null
      }
      if (image.complete && image.naturalWidth > 0) {
        cleanup()
        resolve()
        return
      }
      image.onload = () => {
        cleanup()
        resolve()
      }
      image.onerror = (error: unknown) => {
        cleanup()
        this.loadFailed = true
        reject(new PetError(ErrorCode.MODEL_LOAD_FAILED, `帧序列底图加载失败：${this.sheet.image}`, { cause: error }))
      }
      image.src = loadContext.source
    })

    if (this.disposed) {
      this.image = null
      return
    }
    if (image.naturalWidth <= 0) {
      this.loadFailed = true
      throw new PetError(ErrorCode.MODEL_NOT_RENDERABLE, `帧序列底图没有有效尺寸：${this.sheet.image}`)
    }
    this.loaded = true
    if (this.canvas !== null) this.paint()
  }

  attach(canvas: HTMLCanvasElement): void {
    this.canvas = canvas
    canvas.width = Math.round(this.profile.w * this.dpr)
    canvas.height = Math.round(this.profile.h * this.dpr)
    this.paint()
  }

  resize(profile: SizeProfile): void {
    if (this.disposed) return
    this.profile = profile
    if (this.canvas === null) return
    this.canvas.width = Math.round(profile.w * this.dpr)
    this.canvas.height = Math.round(profile.h * this.dpr)
    this.paint()
  }

  /** 切到指定动作；播完回默认的逻辑只对非循环片段生效。 */
  playAction(name: string): void {
    if (this.disposed) throw new PetError(ErrorCode.MODEL_LOAD_FAILED, '模型已释放')
    const clip = this.clips.get(name)
    if (clip === undefined) {
      throw new PetError(ErrorCode.INVALID_ARGUMENT, `没有这个动作：${name}`, {
        details: { available: [...this.clips.keys()] }
      })
    }
    this.action = clip
    this.frameIndex = 0
    this.frameElapsed = 0
    this.paint()
  }

  /** 回到默认动作。 */
  stopAction(): void {
    this.playAction(this.defaultAction)
  }

  tick(dt: number): void {
    if (this.disposed || !this.loaded || this.paused) return
    if (!(dt > 0)) return

    const frameDuration = 1 / this.action.fps
    this.frameElapsed += dt

    // while 而非 if：一帧 dt 里可能跨过多帧，低帧率设备上必须追上。
    while (this.frameElapsed >= frameDuration) {
      this.frameElapsed -= frameDuration
      this.frameIndex += 1

      if (this.frameIndex >= this.action.frameCount) {
        if (this.action.loop) {
          this.frameIndex = 0
        } else {
          // 非循环动作播到最后一帧：停在末帧，然后回默认。
          this.frameIndex = this.action.frameCount - 1
          this.playAction(this.defaultAction)
          break
        }
      }
    }

    this.paint()
  }

  pause(): void {
    this.paused = true
  }

  resume(): void {
    this.paused = false
  }

  dispose(): void {
    this.image = null
    this.canvas = null
    this.loaded = false
    this.disposed = true
  }

  isRenderable(): boolean {
    return !this.disposed && this.loaded && (this.image?.naturalWidth ?? 0) > 0
  }

  private paint(): void {
    if (this.image === null || this.canvas === null || !this.loaded) return
    const ctx = this.canvas.getContext('2d')
    if (ctx === null) return

    const absolute = this.action.startFrame + this.frameIndex
    const { columns, rows, frameWidth, frameHeight } = this.sheet.grid
    if (absolute < 0 || absolute >= columns * rows) return

    const col = absolute % columns
    const row = Math.floor(absolute / columns)

    try {
      // 画布比例由窗口尺寸决定，和素材帧比例通常不一致。
      // 直接拉满会把立绘压扁，这里按短边等比缩放并居中，多出来的方向留透明。
      const scale = Math.min(
        this.canvas.width / frameWidth,
        this.canvas.height / frameHeight
      )
      const targetWidth = frameWidth * scale
      const targetHeight = frameHeight * scale
      const offsetX = (this.canvas.width - targetWidth) / 2
      const offsetY = (this.canvas.height - targetHeight) / 2

      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
      ctx.drawImage(
        this.image as unknown as CanvasImageSource,
        col * frameWidth,
        row * frameHeight,
        frameWidth,
        frameHeight,
        offsetX,
        offsetY,
        targetWidth,
        targetHeight
      )
    } catch {
      // 测试替身没有真实 2D 上下文时跳过绘制，不影响 renderable 判定
    }
  }
}
