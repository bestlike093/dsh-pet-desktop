import { ErrorCode, PetError } from '@pet/shared'
import type { IModel, LoadContext, ModelKind, SizeProfile } from '@pet/shared'
import type { AdapterContext, ModelAdapter } from './adapterRegistry.js'

export interface VideoLike {
  src: string
  readyState: number
  videoWidth: number
  videoHeight: number
  muted: boolean
  loop: boolean
  playsInline?: boolean
  onloadedmetadata?: (() => void) | null
  onloadeddata: (() => void) | null
  onerror: ((error: unknown) => void) | null
  play(): Promise<void>
  pause(): void
  load(): void
  /** 真实元素用它断开 src；测试替身可以只支持 src。 */
  removeAttribute?: (name: string) => void
  /** 元素已挂进文档时用于摘除；测试替身可以没有。 */
  remove?: () => void
}

export interface VideoAdapterOptions {
  readonly createVideo?: () => VideoLike
  /** 元素摘除钩子：dispose 时调用，默认 video.remove()。 */
  readonly releaseVideo?: (video: VideoLike) => void
}

function defaultCreateVideo(): VideoLike {
  const g = globalThis as unknown as { document?: Document }
  if (g.document === undefined) {
    throw new PetError(ErrorCode.MODEL_LOAD_FAILED, '当前环境没有 document，无法加载视频')
  }
  return g.document.createElement('video') as unknown as VideoLike
}

export class VideoModel implements IModel {
  readonly id: string
  readonly kind: ModelKind = 'video'
  profile: SizeProfile
  private readonly source: string
  private readonly dpr: number
  private readonly createVideo: () => VideoLike
  private readonly releaseVideo: (video: VideoLike) => void
  private video: VideoLike | null = null
  private canvas: HTMLCanvasElement | null = null
  private loaded = false
  private paused = false
  private disposed = false
  /** 尺寸门未开时暂存，等 loadedmetadata 补应用；换源时保留。 */
  private pendingProfile: SizeProfile | null = null

  constructor(context: AdapterContext, options: VideoAdapterOptions = {}) {
    this.id = context.id
    this.profile = context.profile
    this.source = context.source
    this.dpr = context.dpr
    this.createVideo = options.createVideo ?? defaultCreateVideo
    this.releaseVideo = options.releaseVideo ?? ((video) => video.remove?.())
  }

  async load(loadContext: LoadContext): Promise<void> {
    if (this.disposed) throw new PetError(ErrorCode.MODEL_LOAD_FAILED, '模型已释放')

    // 换源：上一轮的“可渲染”判定立即失效，新源要重新走两道门。
    this.loaded = false
    const video = this.createVideo()
    video.muted = true
    video.loop = true
    video.playsInline = true
    this.video = video

    await new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        video.onloadedmetadata = null
        video.onloadeddata = null
        video.onerror = null
      }

      // 尺寸门：只要有元数据就能拿到固有宽高，不必等首帧。
      if (video.readyState >= 1 && video.videoWidth > 0) this.applyLayout()
      // 首帧门：HAVE_CURRENT_DATA 才算可渲染。
      if (video.readyState >= 2 && video.videoWidth > 0) {
        cleanup()
        resolve()
        return
      }

      video.onloadedmetadata = () => {
        if (this.disposed) return
        this.applyLayout()
      }
      video.onloadeddata = () => {
        if (this.disposed) return
        // 帧已到：补一次布局，确保“元信息先到、帧后到”时不会停在旧尺寸。
        this.applyLayout()
        cleanup()
        resolve()
      }
      video.onerror = (error: unknown) => {
        cleanup()
        reject(new PetError(ErrorCode.MODEL_LOAD_FAILED, `视频加载失败：${this.source}`, { cause: error }))
      }
      video.src = loadContext.source
      video.load()
    })

    if (video.videoWidth <= 0) {
      throw new PetError(ErrorCode.MODEL_NOT_RENDERABLE, `视频没有有效尺寸：${this.source}`)
    }

    this.loaded = true
    // 后挂载的 canvas 在媒体就绪后才拿到原始宽高，这里补一次布局。
    this.applyLayout()
    try {
      await video.play()
    } catch {
      // 自动播放被策略拦截时保留首帧，不算加载失败
    }
  }

  attach(canvas: HTMLCanvasElement): void {
    this.canvas = canvas
    const g = canvas as unknown as { parentNode?: { insertBefore?: (node: unknown, ref: unknown) => void } }
    const parent = g.parentNode
    if (parent?.insertBefore !== undefined && this.video !== null) {
      try {
        parent.insertBefore(this.video, canvas)
      } catch {
        // 测试替身没有真实 DOM，跳过挂载
      }
    }
  }

  /**
   * 只改布局与画布像素尺寸。
   * 不得触碰 `<video>`：不调 load()、不改 src、不暂停/重播，播放进度保持原样。
   *
   * 尺寸门与首帧门分开：
   * - `readyState >= HAVE_METADATA(1)` 就能拿到固有宽高，可立即应用；
   * - `readyState < 1`（换源瞬间 / 启动期）不丢弃，先存 `pendingProfile`，等 loadedmetadata 补。
   */
  resize(profile: SizeProfile): void {
    if (this.disposed) return
    this.profile = profile
    if (this.video === null || this.video.readyState < 1 || this.video.videoWidth <= 0) {
      this.pendingProfile = profile
      return
    }
    this.applyLayout()
  }

  private applyLayout(): void {
    if (this.disposed) return
    if (this.canvas === null) return
    if (this.video === null) return
    // 尺寸门只到 HAVE_METADATA；首帧门由 isRenderable() 单独看。
    if (this.video.readyState < 1 || this.video.videoWidth <= 0) return
    this.canvas.width = Math.round(this.profile.w * this.dpr)
    this.canvas.height = Math.round(this.profile.h * this.dpr)
    this.pendingProfile = null
  }

  tick(): void {
    // 视频由浏览器原生解码，宿主不需要逐帧推进
  }

  pause(): void {
    this.paused = true
    this.video?.pause()
  }

  resume(): void {
    this.paused = false
    void this.video?.play().catch(() => undefined)
  }

  dispose(): void {
    const video = this.video
    if (video !== null) {
      // 赋值式监听用 removeEventListener 清不掉，只能逐项置 null。
      video.onloadedmetadata = null
      video.onloadeddata = null
      video.onerror = null
      video.pause()
      // src = '' 会让浏览器把当前页面 URL 当视频源去请求；
      // 先断开 src 再 load()，才会真正释放解码器与缓冲。
      if (video.removeAttribute !== undefined) {
        video.removeAttribute('src')
      } else {
        video.src = ''
      }
      video.load()
    }
    this.video = null
    this.loaded = false
    this.pendingProfile = null
    this.disposed = true

    // 解码已断开，最后再从文档摘除。
    if (video !== null) this.releaseVideo(video)
  }

  isRenderable(): boolean {
    if (this.disposed || !this.loaded || this.video === null) return false
    return this.video.readyState >= 2 && this.video.videoWidth > 0
  }

  get isPaused(): boolean {
    return this.paused
  }
}

export function createVideoAdapter(options: VideoAdapterOptions = {}): ModelAdapter {
  return {
    kind: 'video',
    create: (context) => new VideoModel(context, options)
  }
}
