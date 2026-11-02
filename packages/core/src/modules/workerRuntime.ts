import { ErrorCode, PetError, isPetError } from '@pet/shared'
import type { IPetalModule, ModuleConfig, Permission } from '@pet/shared'
import { createDisposerRegistry } from './disposer.js'
import { installRealmNetworkGuard } from './moduleSandbox.js'
import type { SandboxApi, SandboxUiPanel } from './moduleSandbox.js'
import type {
  WorkerCapability,
  WorkerModuleMessage,
  WorkerRuntimeMessage,
  WorkerScope
} from './workerProtocol.js'
import { isWorkerMessage, toErrorCode } from './workerProtocol.js'

export interface WorkerRuntimeOptions {
  readonly scope: WorkerScope
  /** 由具体 Worker 入口注入，负责把 url 变成模块实例。 */
  readonly loadModule: (url: string) => Promise<IPetalModule>
  /** 网络遮蔽目标；默认 globalThis，单测可传替身避免影响测试进程。 */
  readonly networkTarget?: Record<string, unknown>
}

interface PendingCall {
  readonly resolve: (value: unknown) => void
  readonly reject: (error: unknown) => void
}

function workerError(error: unknown): { code: string; message: string } {
  if (isPetError(error)) return { code: error.code, message: error.message }
  return {
    code: ErrorCode.LOAD_FAILED,
    message: error instanceof Error ? error.message : String(error)
  }
}

/**
 * Worker 线程里的模块运行时。
 *
 * 与主 realm 的 `createSandboxContext` 同构：能力按权限逐项挂载，
 * 差别是每个能力都变成一次 RPC，模块拿不到宿主端口本体，也没有 DOM。
 *
 * 全局网络在这里**无条件**遮蔽：即使模块声明了 net.egress，出网也必须
 * 经 `api.net.fetch → 宿主 onApiCall`，由宿主决定放不放行。
 */
export function runModuleInWorker(options: WorkerRuntimeOptions): void {
  const { scope, loadModule } = options
  const pending = new Map<number, PendingCall>()
  let module: IPetalModule | undefined
  let nextCallId = 1

  installRealmNetworkGuard({
    allowNetwork: false,
    ...(options.networkTarget === undefined ? {} : { target: options.networkTarget })
  })

  const callHost = <T>(capability: WorkerCapability, args: readonly unknown[]): Promise<T> => {
    const callId = nextCallId++
    return new Promise<T>((resolve, reject) => {
      pending.set(callId, { resolve: resolve as (value: unknown) => void, reject })
      scope.postMessage({ type: 'api-call', callId, capability, args })
    })
  }

  const failAll = (error: unknown): void => {
    for (const [callId, entry] of pending) {
      pending.delete(callId)
      entry.reject(error)
    }
  }

  const send = (message: WorkerRuntimeMessage): void => scope.postMessage(message)

  const buildApi = (granted: ReadonlySet<Permission>): SandboxApi => {
    const api: {
      net?: SandboxApi['net']
      fs?: SandboxApi['fs']
      memory?: SandboxApi['memory']
      ui?: SandboxApi['ui']
    } = {}

    if (granted.has('net.egress')) {
      api.net = Object.freeze({
        fetch: (input: string, init?: unknown) => callHost('fetch', [input, init])
      })
    }

    if (granted.has('fs.user-assets.read')) {
      api.fs = Object.freeze({
        readAsset: (path: string) => callHost<Uint8Array>('readAsset', [path])
      })
    }

    if (granted.has('memory.read') || granted.has('memory.write')) {
      const memory: NonNullable<SandboxApi['memory']> = {}
      if (granted.has('memory.read')) {
        memory.read = (key: string) => callHost('readMemory', [key])
      }
      if (granted.has('memory.write')) {
        memory.write = (key: string, value: unknown) => callHost('writeMemory', [key, value])
      }
      api.memory = Object.freeze(memory)
    }

    if (granted.has('ui.render') || granted.has('ui.panel')) {
      const ui: {
        render?: (html: string) => void
        panel?: SandboxUiPanel
      } = {}
      if (granted.has('ui.render')) {
        ui.render = (html: string) => {
          void callHost('render', [html])
        }
      }
      if (granted.has('ui.panel')) {
        ui.panel = Object.freeze({
          register: (spec: unknown) => {
            // 面板注销句柄不能跨线程，Worker 侧只保留一个 token 的 Promise。
            const token = callHost<number>('registerPanel', [spec])
            return () => {
              void token.then((value) => callHost('releasePanel', [value])).catch(() => undefined)
            }
          }
        })
      }
      api.ui = Object.freeze(ui)
    }

    return api as SandboxApi
  }

  const handleInit = async (url: string): Promise<void> => {
    try {
      module = await loadModule(url)
      send({ type: 'ready', meta: module.meta })
    } catch (error) {
      send({ type: 'failed', ...workerError(error) })
    }
  }

  const handleBootstrap = async (
    config: ModuleConfig,
    permissions: readonly Permission[]
  ): Promise<void> => {
    if (module === undefined) {
      send({ type: 'failed', code: ErrorCode.LOAD_FAILED, message: '模块尚未加载' })
      return
    }
    const granted = new Set(permissions)
    const api = buildApi(granted)
    const context = Object.freeze({
      // Worker 没有 DOM；模块只能通过 ui.render / ui.panel 交 HTML 给宿主。
      root: undefined,
      config: Object.freeze({ ...config }),
      disposers: createDisposerRegistry(),
      granted: Object.freeze([...granted]),
      api
    })
    try {
      await module.bootstrap(context as never)
      send({ type: 'bootstrapped' })
    } catch (error) {
      send({ type: 'failed', ...workerError(error) })
    }
  }

  const handleTeardown = async (): Promise<void> => {
    try {
      await module?.teardown()
      send({ type: 'torn-down' })
    } catch (error) {
      send({ type: 'failed', ...workerError(error) })
    } finally {
      failAll(new PetError(ErrorCode.LOAD_FAILED, 'Worker 已停止'))
    }
  }

  const onMessage = (event: { data: unknown }): void => {
    const message: WorkerModuleMessage | undefined = isWorkerMessage(event.data)
      ? (event.data as WorkerModuleMessage)
      : undefined
    if (message === undefined) return
    switch (message.type) {
      case 'init':
        void handleInit(message.url)
        break
      case 'bootstrap':
        void handleBootstrap(message.config, message.granted)
        break
      case 'teardown':
        void handleTeardown()
        break
      case 'api-result': {
        const entry = pending.get(message.callId)
        if (entry === undefined) return
        pending.delete(message.callId)
        if (message.ok) {
          entry.resolve(message.value)
        } else {
          entry.reject(
            new PetError(
              toErrorCode(message.code),
              message.message ?? '宿主能力调用失败'
            )
          )
        }
        break
      }
      default:
        break
    }
  }

  scope.addEventListener('message', onMessage)
}
