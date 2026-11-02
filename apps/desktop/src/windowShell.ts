import { SIZE_PROFILES } from '@pet/shared'
import type { SettingsV2 } from '@pet/shared'

export interface WindowBounds {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface WindowOptions {
  readonly width: number
  readonly height: number
  readonly x?: number
  readonly y?: number
  readonly transparent: boolean
  readonly frame: boolean
  readonly alwaysOnTop: boolean
  readonly resizable: boolean
  readonly skipTaskbar: boolean
  readonly hasShadow: boolean
  readonly webPreferences: {
    readonly preload: string
    readonly contextIsolation: true
    readonly nodeIntegration: false
    readonly sandbox: true
  }
}

/** 由设置推导 BrowserWindow 配置，保持 core 与 Electron 完全解耦。 */
export function createWindowOptions(settings: SettingsV2, preloadPath: string): WindowOptions {
  const profile =
    settings.profile === 'custom' ? SIZE_PROFILES.vertical : SIZE_PROFILES[settings.profile]
  const scale = settings.window.scale
  const width = Math.round(profile.w * scale)
  const height = Math.round(profile.h * scale)

  return {
    width,
    height,
    ...(settings.window.x === undefined ? {} : { x: settings.window.x }),
    ...(settings.window.y === undefined ? {} : { y: settings.window.y }),
    transparent: true,
    frame: false,
    alwaysOnTop: settings.window.alwaysOnTop,
    // 固定窗口：尺寸只由设置里的缩放倍数决定，不提供拖边框缩放。
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  }
}

export interface WindowLike {
  setIgnoreMouseEvents(ignore: boolean, options?: { forward?: boolean }): void
  setAlwaysOnTop(flag: boolean): void
  getBounds(): WindowBounds
  setBounds(bounds: Partial<WindowBounds>): void
  loadFile(path: string): Promise<void>
  show(): void
  hide(): void
  isDestroyed(): boolean
}

export interface WindowControllerOptions {
  readonly initialPosition?: { readonly x: number; readonly y: number }
  readonly persist?: (bounds: WindowBounds) => Promise<void> | void
}

/**
 * 窗口控制器：点击穿透、置顶、位置恢复与持久化。
 * 不引用 Electron 类型，真实壳只需实现 WindowLike。
 */
export class WindowController {
  private readonly window: WindowLike
  private readonly persist: ((bounds: WindowBounds) => Promise<void> | void) | undefined
  private readonly initialPosition: { readonly x: number; readonly y: number } | undefined
  private clickThrough = false

  constructor(window: WindowLike, options: WindowControllerOptions = {}) {
    this.window = window
    this.persist = options.persist
    this.initialPosition = options.initialPosition
  }

  get isClickThrough(): boolean {
    return this.clickThrough
  }

  /** 穿透时保留 mousemove 转发，宠物仍然能感知鼠标靠近。 */
  setClickThrough(enabled: boolean): void {
    this.clickThrough = enabled
    this.window.setIgnoreMouseEvents(enabled, { forward: true })
  }

  toggleClickThrough(): boolean {
    this.setClickThrough(!this.clickThrough)
    return this.clickThrough
  }

  setAlwaysOnTop(flag: boolean): void {
    this.window.setAlwaysOnTop(flag)
  }

  restorePosition(): void {
    if (this.initialPosition === undefined) return
    this.window.setBounds({ x: this.initialPosition.x, y: this.initialPosition.y })
  }

  bounds(): WindowBounds {
    return this.window.getBounds()
  }

  async savePosition(): Promise<WindowBounds> {
    const bounds = this.window.getBounds()
    if (this.persist !== undefined) await this.persist(bounds)
    return bounds
  }

  show(): void {
    if (!this.window.isDestroyed()) this.window.show()
  }

  hide(): void {
    if (!this.window.isDestroyed()) this.window.hide()
  }

  async load(filePath: string): Promise<void> {
    await this.window.loadFile(filePath)
  }
}
