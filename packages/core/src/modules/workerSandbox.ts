import { ErrorCode, PetError } from '@pet/shared'
import type { IPetalModule, ModuleContext, ModuleMeta, PanelSpec } from '@pet/shared'
import type { ModuleLoader, ModuleSourceKind } from './moduleLoader.js'
import type { SandboxModuleContext } from './moduleSandbox.js'
import type {
  WorkerCapability,
  WorkerModuleMessage,
  WorkerRuntimeMessage,
  WorkerScope
} from './workerProtocol.js'
import { isWorkerMessage, toErrorCode } from './workerProtocol.js'

/** 宿主侧看到的 Worker 句柄；测试可传同线程替身。 */
export interface WorkerHandle extends WorkerScope {
  terminate?(): void
}

export interface WorkerApiCall {
  readonly capability: WorkerCapability
  readonly args: readonly unknown[]
}

export interface WorkerModuleLoaderOptions {
  /** 模块 id → Worker 入口 URL。 */
  readonly sources: Iterable<readonly [string, string]>
  readonly createWorker: (url: string) => WorkerHandle
  /**
   * Worker 发起的能力调用。`registerPanel` 需要返回一个注销函数，
   * 其余能力按原样返回结果。宿主必须在这里再做一次权限与参数校验。
   */
  readonly onApiCall: (call: WorkerApiCall) => unknown | Promise<unknown>
  readonly timeoutMs?: number
}

export interface WorkerModuleLoader extends ModuleLoader {
  /** 主动结束某个模块的 Worker；未加载的 id 视为已结束。 */
  terminate(id: string): void
}

const DEFAULT_TIMEOUT_MS = 5_000

interface Waiter {
  readonly resolve: (message: WorkerRuntimeMessage) => void
  readonly reject: (error: unknown) => void
  readonly timer: ReturnType<typeof setTimeout>
}

/**
 * Worker 隔离版模块加载器。
 *
 * 模块代码、模块的全局对象、模块里能访问到的 DOM 全在独立线程里；
 * 宿主只通过消息提供 `onApiCall`，不再把端口对象和 ShadowRoot 递过去。
 */
export function createWorkerModuleLoader(options: WorkerModuleLoaderOptions): WorkerModuleLoader {
  const sources = new Map<string, string>(options.sources)
  const loaded = new Map<string, WorkerModule>()
  const inflight = new Map<string, Promise<WorkerModule>>()
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  const load = async (id: string): Promise<IPetalModule> => {
    const cached = loaded.get(id)
    if (cached !== undefined) return cached
    const pending = inflight.get(id)
    if (pending !== undefined) return pending

    const url = sources.get(id)
    if (url === undefined) {
      throw new PetError(ErrorCode.LOAD_FAILED, `模块不存在：${id}`)
    }

    const promise = WorkerModule.create(id, url, options, timeoutMs).then((module) => {
      loaded.set(id, module)
      return module
    })
    inflight.set(id, promise)
    try {
      return await promise
    } finally {
      inflight.delete(id)
    }
  }

  return {
    kind: 'worker' satisfies ModuleSourceKind,
    load,
    has: (id) => loaded.has(id),
    ids: () => [...new Set([...sources.keys(), ...loaded.keys()])],
    get size() {
      return loaded.size
    },
    terminate(id: string): void {
      const module = loaded.get(id)
      module?.terminate()
      loaded.delete(id)
    }
  }
}

class WorkerModule implements IPetalModule {
  readonly meta: ModuleMeta
  private readonly id: string
  private readonly worker: WorkerHandle
  private readonly timeoutMs: number
  private readonly onApiCall: WorkerModuleLoaderOptions['onApiCall']
  /** 同一时刻只有一个生命周期动作在等待：ready / bootstrapped / torn-down。 */
  private waiter: { readonly type: WorkerRuntimeMessage['type']; readonly entry: Waiter } | undefined
  private readonly panelTokens = new Map<number, () => void>()
  private nextPanelToken = 1
  private terminated = false
  private readonly onMessage = (event: { data: unknown }): void => {
    this.handleMessage(event.data)
  }

  private constructor(
    id: string,
    worker: WorkerHandle,
    meta: ModuleMeta,
    options: WorkerModuleLoaderOptions,
    timeoutMs: number
  ) {
    this.id = id
    this.worker = worker
    this.meta = meta
    this.onApiCall = options.onApiCall
    this.timeoutMs = timeoutMs
    worker.addEventListener('message', this.onMessage)
  }

  static async create(
    id: string,
    url: string,
    options: WorkerModuleLoaderOptions,
    timeoutMs: number
  ): Promise<WorkerModule> {
    const worker = options.createWorker(url)
    const metaPromise = new Promise<ModuleMeta>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup()
        reject(new PetError(ErrorCode.LOAD_TIMEOUT, `Worker 加载超时：${id}`))
      }, timeoutMs)
      const cleanup = (): void => {
        clearTimeout(timer)
        worker.removeEventListener('message', listener)
      }
      const listener = (event: { data: unknown }): void => {
        if (!isWorkerMessage(event.data)) return
        const message = event.data as WorkerRuntimeMessage
        if (message.type === 'ready') {
          cleanup()
          resolve(message.meta)
        } else if (message.type === 'failed') {
          cleanup()
          reject(new PetError(toErrorCode(message.code), message.message))
        }
      }
      worker.addEventListener('message', listener)
    })

    worker.postMessage({ type: 'init', url })
    try {
      const meta = await metaPromise
      return new WorkerModule(id, worker, meta, options, timeoutMs)
    } catch (error) {
      worker.terminate?.()
      throw error
    }
  }

  async bootstrap(ctx: ModuleContext): Promise<void> {
    const sandbox = ctx as SandboxModuleContext
    const wait = this.waitFor('bootstrapped')
    this.worker.postMessage({
      type: 'bootstrap',
      config: sandbox.config,
      granted: sandbox.granted
    })
    await wait
  }

  async teardown(): Promise<void> {
    if (this.terminated) return
    const wait = this.waitFor('torn-down')
    this.worker.postMessage({ type: 'teardown' })
    await wait
    this.terminate()
  }

  terminate(): void {
    if (this.terminated) return
    this.terminated = true
    this.worker.removeEventListener('message', this.onMessage)
    if (this.waiter !== undefined) {
      clearTimeout(this.waiter.entry.timer)
      this.waiter.entry.reject(new PetError(ErrorCode.LOAD_FAILED, `Worker 已停止：${this.id}`))
      this.waiter = undefined
    }
    for (const dispose of this.panelTokens.values()) dispose()
    this.panelTokens.clear()
    this.worker.terminate?.()
  }

  private waitFor(type: WorkerRuntimeMessage['type']): Promise<WorkerRuntimeMessage> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = undefined
        reject(new PetError(ErrorCode.LOAD_TIMEOUT, `Worker 消息超时：${type}`))
      }, this.timeoutMs)
      this.waiter = { type, entry: { resolve, reject, timer } }
    })
  }

  private settle(message: WorkerRuntimeMessage): void {
    const waiter = this.waiter
    if (waiter === undefined) return
    // failed 不属于某个生命周期消息，但必须唤醒当前的等待者。
    if (message.type !== waiter.type && message.type !== 'failed') return
    clearTimeout(waiter.entry.timer)
    this.waiter = undefined
    if (message.type === 'failed') {
      waiter.entry.reject(new PetError(toErrorCode(message.code), message.message))
    } else {
      waiter.entry.resolve(message)
    }
  }

  private handleMessage(value: unknown): void {
    if (!isWorkerMessage(value)) return
    const message = value as WorkerRuntimeMessage
    if (message.type === 'api-call') {
      void this.runApiCall(message)
      return
    }
    this.settle(message)
  }

  private async runApiCall(message: Extract<WorkerModuleMessage, { type: 'api-call' }>): Promise<void> {
    try {
      const result = await this.onApiCall({
        capability: message.capability,
        args: message.args
      })
      let value = result
      if (message.capability === 'registerPanel') {
        if (typeof result !== 'function') {
          throw new PetError(ErrorCode.NOT_SUPPORTED, 'registerPanel 必须返回注销函数')
        }
        const token = this.nextPanelToken++
        this.panelTokens.set(token, result as () => void)
        value = token
      } else if (message.capability === 'releasePanel') {
        const token = Number(message.args[0])
        this.panelTokens.get(token)?.()
        this.panelTokens.delete(token)
        value = undefined
      }
      this.worker.postMessage({ type: 'api-result', callId: message.callId, ok: true, value })
    } catch (error) {
      this.worker.postMessage({
        type: 'api-result',
        callId: message.callId,
        ok: false,
        code: error instanceof PetError ? error.code : ErrorCode.NOT_SUPPORTED,
        message: error instanceof Error ? error.message : String(error)
      })
    }
  }
}

/** 供 Worker 入口复用：把模块 id 与 URL 的映射整理成 loadModule。 */
export function urlLoader(
  sources: ReadonlyMap<string, string>,
  load: (url: string) => Promise<IPetalModule>
): (url: string) => Promise<IPetalModule> {
  const byUrl = new Map<string, string>()
  for (const [id, url] of sources) byUrl.set(url, id)
  return (url) => load(byUrl.get(url) ?? url)
}

/** 面板规格类型在此导出，避免 Worker 入口重复依赖 shared。 */
export type WorkerPanelSpec = PanelSpec
