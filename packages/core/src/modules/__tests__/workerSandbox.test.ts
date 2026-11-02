import { describe, expect, it, vi } from 'vitest'
import { ErrorCode, PetError } from '@pet/shared'
import type { IPetalModule, ModuleContext } from '@pet/shared'
import type { SandboxModuleContext } from '../moduleSandbox.js'
import { createWorkerModuleLoader } from '../workerSandbox.js'
import type { WorkerApiCall, WorkerHandle } from '../workerSandbox.js'
import { runModuleInWorker } from '../workerRuntime.js'
import type { WorkerModuleMessage, WorkerScope } from '../workerProtocol.js'

type Listener = (event: { data: unknown }) => void

/** 同线程的一对 scope，用来在单测里模拟 Worker 的异步消息边界。 */
function createLoopback(): { host: WorkerHandle; worker: WorkerScope } {
  const hostListeners = new Set<Listener>()
  const workerListeners = new Set<Listener>()

  const deliver = (listeners: Set<Listener>, data: unknown): void => {
    const copy = structuredClone(data) as WorkerModuleMessage
    for (const listener of [...listeners]) listener({ data: copy })
  }

  return {
    host: {
      postMessage: (message) => queueMicrotask(() => deliver(workerListeners, message)),
      addEventListener: (_type, listener) => {
        hostListeners.add(listener)
      },
      removeEventListener: (_type, listener) => {
        hostListeners.delete(listener)
      },
      terminate: () => {
        hostListeners.clear()
      }
    },
    worker: {
      postMessage: (message) => queueMicrotask(() => deliver(hostListeners, message)),
      addEventListener: (_type, listener) => {
        workerListeners.add(listener)
      },
      removeEventListener: (_type, listener) => {
        workerListeners.delete(listener)
      }
    }
  }
}

function context(granted: SandboxModuleContext['granted']): ModuleContext {
  return {
    config: { enabled: true, granted: [], options: {} },
    granted
  } as unknown as ModuleContext
}

describe('Worker 模块沙箱', () => {
  it('模块跑在 Worker 侧，能力调用经宿主代理', async () => {
    const { host, worker } = createLoopback()
    const calls: WorkerApiCall[] = []
    const seen: { granted?: string[]; result?: unknown } = {}

    const module: IPetalModule = {
      meta: { id: 'demo', name: '演示', version: '1.0.0', tier: 'general', permissions: ['net.egress'] },
      async bootstrap(ctx) {
        const sandbox = ctx as SandboxModuleContext
        seen.granted = [...sandbox.granted]
        seen.result = await sandbox.api.net?.fetch('https://example.com/balance')
      },
      async teardown() {}
    }

    runModuleInWorker({
      scope: worker,
      loadModule: async () => module,
      networkTarget: {}
    })

    const loader = createWorkerModuleLoader({
      sources: [['demo', 'worker://demo']],
      createWorker: () => host,
      onApiCall: (call) => {
        calls.push(call)
        return { ok: true, status: 200 }
      }
    })

    const loaded = await loader.load('demo')
    expect(loaded.meta.id).toBe('demo')
    expect(loader.kind).toBe('worker')

    await loaded.bootstrap(context(['net.egress']))

    expect(seen.granted).toEqual(['net.egress'])
    expect(seen.result).toEqual({ ok: true, status: 200 })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.capability).toBe('fetch')
    expect(calls[0]?.args[0]).toBe('https://example.com/balance')
  })

  it('未授予 net.egress 时 Worker 里根本没有 api.net', async () => {
    const { host, worker } = createLoopback()
    const seen: { hasNet?: boolean } = {}

    const module: IPetalModule = {
      meta: { id: 'plain', name: '无网', version: '1.0.0', tier: 'general', permissions: [] },
      async bootstrap(ctx) {
        seen.hasNet = (ctx as SandboxModuleContext).api.net !== undefined
      },
      async teardown() {}
    }

    runModuleInWorker({ scope: worker, loadModule: async () => module, networkTarget: {} })
    const loader = createWorkerModuleLoader({
      sources: [['plain', 'worker://plain']],
      createWorker: () => host,
      onApiCall: () => undefined
    })

    await (await loader.load('plain')).bootstrap(context([]))
    expect(seen.hasNet).toBe(false)
  })

  it('模块 bootstrap 抛错时宿主收到原始错误码', async () => {
    const { host, worker } = createLoopback()

    const module: IPetalModule = {
      meta: { id: 'boom', name: '崩溃', version: '1.0.0', tier: 'general', permissions: [] },
      async bootstrap() {
        throw new PetError(ErrorCode.PERMISSION_DENIED, '模块被拒绝')
      },
      async teardown() {}
    }

    runModuleInWorker({ scope: worker, loadModule: async () => module, networkTarget: {} })
    const loader = createWorkerModuleLoader({
      sources: [['boom', 'worker://boom']],
      createWorker: () => host,
      onApiCall: () => undefined
    })

    await expect((await loader.load('boom')).bootstrap(context([]))).rejects.toMatchObject({
      code: ErrorCode.PERMISSION_DENIED
    })
  })

  it('registerPanel 的注销函数通过 token 跨线程生效', async () => {
    const { host, worker } = createLoopback()
    const dispose = vi.fn()
    const calls: WorkerApiCall[] = []

    const module: IPetalModule = {
      meta: { id: 'panel', name: '面板', version: '1.0.0', tier: 'general', permissions: ['ui.panel'] },
      async bootstrap(ctx) {
        const panel = (ctx as SandboxModuleContext).api.ui?.panel
        const unregister = panel?.register({
          id: 'demo',
          title: '演示',
          order: 1,
          html: '<div>ok</div>'
        })
        unregister?.()
      },
      async teardown() {}
    }

    runModuleInWorker({ scope: worker, loadModule: async () => module, networkTarget: {} })
    const loader = createWorkerModuleLoader({
      sources: [['panel', 'worker://panel']],
      createWorker: () => host,
      onApiCall: (call) => {
        calls.push(call)
        return call.capability === 'registerPanel' ? dispose : undefined
      }
    })

    await (await loader.load('panel')).bootstrap(context(['ui.panel']))

    // releasePanel 是注销函数在 token 回来后补发的，多等一拍消息。
    await vi.waitFor(() => {
      expect(calls.map((call) => call.capability)).toEqual(['registerPanel', 'releasePanel'])
    })
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it('teardown 会通知 Worker 并结束线程', async () => {
    const { host, worker } = createLoopback()
    const terminate = vi.fn()
    host.terminate = terminate
    const tornDown = vi.fn()

    const module: IPetalModule = {
      meta: { id: 'life', name: '生命周期', version: '1.0.0', tier: 'general', permissions: [] },
      async bootstrap() {},
      async teardown() {
        tornDown()
      }
    }

    runModuleInWorker({ scope: worker, loadModule: async () => module, networkTarget: {} })
    const loader = createWorkerModuleLoader({
      sources: [['life', 'worker://life']],
      createWorker: () => host,
      onApiCall: () => undefined
    })

    const loaded = await loader.load('life')
    await loaded.bootstrap(context([]))
    await loaded.teardown()

    expect(tornDown).toHaveBeenCalledTimes(1)
    expect(terminate).toHaveBeenCalledTimes(1)
  })
})
