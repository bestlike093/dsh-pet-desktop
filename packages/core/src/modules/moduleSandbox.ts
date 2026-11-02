import { ErrorCode, PetError } from '@pet/shared'
import type { DisposerRegistry, ModuleConfig, ModuleContext, PanelSpec, Permission } from '@pet/shared'
import { createDisposerRegistry } from './disposer.js'

/** 沙箱里能看到的端口。真实实现由桌面壳注入，core 不直接碰网络与磁盘。 */
export interface SandboxPorts {
  readonly fetch?: (input: string, init?: unknown) => Promise<unknown>
  readonly readAsset?: (path: string) => Promise<Uint8Array>
  readonly readMemory?: (key: string) => Promise<unknown>
  readonly writeMemory?: (key: string, value: unknown) => Promise<void>
  readonly render?: (html: string) => void
  /** 注册侧边栏面板；返回注销函数 */
  readonly registerPanel?: (spec: PanelSpec) => () => void
}

/** 面板注册入口。模块只能交 HTML，宿主负责挂载与销毁。 */
export interface SandboxUiPanel {
  register(spec: PanelSpec): () => void
}

/** 接口按权限逐项挂载：没有授予的能力在对象上根本不存在。 */
export interface SandboxApi {
  readonly net?: { fetch(input: string, init?: unknown): Promise<unknown> }
  readonly fs?: { readAsset(path: string): Promise<Uint8Array> }
  readonly memory?: {
    read?: (key: string) => Promise<unknown>
    write?: (key: string, value: unknown) => Promise<void>
  }
  readonly ui?: {
    /** 仅在授予 ui.render 时存在 */
    readonly render?: (html: string) => void
    /** 仅在授予 ui.panel 时存在 */
    readonly panel?: SandboxUiPanel
  }
}

export interface SandboxModuleContext extends ModuleContext {
  readonly api: SandboxApi
  readonly granted: readonly Permission[]
}

export interface SandboxOptions {
  readonly root: ShadowRoot
  readonly config: ModuleConfig
  readonly granted: readonly Permission[]
  readonly ports?: SandboxPorts
  readonly disposers?: DisposerRegistry
}

function requirePort<T>(port: T | undefined, name: string): T {
  if (port === undefined) {
    throw new PetError(ErrorCode.NOT_SUPPORTED, `宿主未提供沙箱端口：${name}`)
  }
  return port
}

/** 递归冻结普通对象与数组。函数、DOM 节点等保持原样，只冻结容器。 */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item)
    return Object.freeze(value)
  }
  // 端口函数与 DOM 对象不递归：它们由宿主持有，冻结容器即可挡住“换掉整个端口”。
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    return value
  }
  for (const key of Object.keys(value)) {
    deepFreeze((value as Record<string, unknown>)[key])
  }
  return Object.freeze(value)
}

/** 主 realm 里能被模块直接抓到的出网入口。 */
const NETWORK_GLOBALS = ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource'] as const

export interface RealmGuardOptions {
  /** true 表示模块已获授 net.egress，保留全局网络入口。 */
  readonly allowNetwork: boolean
  /** 默认 globalThis；测试可传替身。 */
  readonly target?: Record<string, unknown>
}

interface SavedDescriptor {
  readonly key: string
  readonly descriptor: PropertyDescriptor | undefined
}

/**
 * 在模块执行期间遮蔽全局出网入口。
 *
 * 这是「同 realm 内的最小缓解」，不是隔离：模块只要把 fetch 提前存下来，
 * 或换个还没被挡住的对象，就能越过。真正的边界在 Worker（见 workerSandbox.ts）。
 * 遮蔽期结束后按原 descriptor 还原，不留下永久副作用。
 */
export function installRealmNetworkGuard(options: RealmGuardOptions): () => void {
  if (options.allowNetwork) return () => undefined
  const target = options.target ?? (globalThis as unknown as Record<string, unknown>)
  const saved: SavedDescriptor[] = []

  for (const key of NETWORK_GLOBALS) {
    const descriptor = Object.getOwnPropertyDescriptor(target, key)
    if (descriptor === undefined && !(key in target)) continue
    saved.push({ key, descriptor })
    const deny = (): never => {
      throw new PetError(ErrorCode.PERMISSION_DENIED, `未授予 net.egress，禁止使用 ${key}`)
    }
    try {
      Object.defineProperty(target, key, {
        configurable: true,
        enumerable: descriptor?.enumerable ?? false,
        get: () => deny,
        set: () => undefined
      })
    } catch {
      // 宿主属性不可重定义时只能跳过；这条限制会由 Worker 隔离兜住。
    }
  }

  return () => {
    for (const { key, descriptor } of saved.reverse()) {
      try {
        if (descriptor === undefined) {
          delete target[key]
        } else {
          Object.defineProperty(target, key, descriptor)
        }
      } catch {
        // 还原失败不影响模块隔离结论，最坏是留一个被遮蔽的全局。
      }
    }
  }
}

/**
 * 构建模块上下文。
 * 权限判断在构建时完成，运行期不再给未授权模块补接口。
 */
export function createSandboxContext(options: SandboxOptions): SandboxModuleContext {
  const granted = new Set<Permission>(options.granted)
  const ports = options.ports ?? {}
  const api: {
    net?: SandboxApi['net']
    fs?: SandboxApi['fs']
    memory?: SandboxApi['memory']
    ui?: SandboxApi['ui']
  } = {}

  if (granted.has('net.egress')) {
    api.net = {
      fetch: (input, init) => requirePort(ports.fetch, 'fetch')(input, init)
    }
  }

  if (granted.has('fs.user-assets.read')) {
    api.fs = {
      readAsset: (path) => requirePort(ports.readAsset, 'readAsset')(path)
    }
  }

  if (granted.has('memory.read') || granted.has('memory.write')) {
    const memory: NonNullable<SandboxApi['memory']> = {}
    if (granted.has('memory.read')) {
      memory.read = (key) => requirePort(ports.readMemory, 'readMemory')(key)
    }
    if (granted.has('memory.write')) {
      memory.write = (key, value) => requirePort(ports.writeMemory, 'writeMemory')(key, value)
    }
    api.memory = memory
  }

  if (granted.has('ui.render') || granted.has('ui.panel')) {
    const ui: {
      render?: (html: string) => void
      panel?: SandboxUiPanel
    } = {}
    if (granted.has('ui.render')) {
      ui.render = (html) => requirePort(ports.render, 'render')(html)
    }
    if (granted.has('ui.panel')) {
      ui.panel = {
        register: (spec) => requirePort(ports.registerPanel, 'registerPanel')(spec)
      }
    }
    api.ui = ui
  }

  return Object.freeze({
    root: options.root,
    config: deepFreeze({ ...options.config }),
    disposers: options.disposers ?? createDisposerRegistry(),
    granted: Object.freeze([...granted]),
    api: deepFreeze(api)
  })
}
