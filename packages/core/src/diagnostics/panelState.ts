import type { DiagnosticsSnapshot } from './diagnostics.js'

/**
 * 面板状态。
 *
 * pending 是独立分支，不复用 ok 的 severity。
 * 诊断还没回来时显示「正在检查」，不得显示成「已就绪」——
 * 假阳性比多等一秒更难排查。
 */
export type PanelStatus =
  | { readonly kind: 'pending' }
  | { readonly kind: 'ready'; readonly snapshot: DiagnosticsSnapshot }
  | { readonly kind: 'error'; readonly reason: string }

export interface PanelControllerOptions {
  /** 拉取一次诊断；渲染进程通常是一层 IPC 调用。 */
  readonly load: () => Promise<DiagnosticsSnapshot>
  readonly render: (status: PanelStatus) => void
}

export interface PanelController {
  refresh(): Promise<void>
  status(): PanelStatus
  /** 已发起的刷新轮次，供测试与诊断断言；不进入渲染。 */
  generation(): number
  dispose(): void
}

/**
 * 诊断刷新控制器。
 *
 * 与 ModuleLoader 的迟到 resolve 同构：连续刷新时，先发起的请求可能后回来。
 * 每次发起递增 generation，回来后比对；不匹配就整包丢弃，不写状态、不渲染。
 */
export function createPanelController(options: PanelControllerOptions): PanelController {
  let current: PanelStatus = { kind: 'pending' }
  let generation = 0
  let disposed = false

  const publish = (next: PanelStatus): void => {
    current = next
    options.render(next)
  }

  return {
    async refresh(): Promise<void> {
      if (disposed) return
      generation += 1
      const mine = generation

      // 新一轮一开始就回到 pending：上一轮的值已经不是最新事实。
      if (current.kind !== 'pending') publish({ kind: 'pending' })

      try {
        const snapshot = await options.load()
        if (disposed || mine !== generation) return
        publish({ kind: 'ready', snapshot })
      } catch (error) {
        if (disposed || mine !== generation) return
        publish({ kind: 'error', reason: error instanceof Error ? error.message : String(error) })
      }
    },

    status: () => current,
    generation: () => generation,

    dispose(): void {
      disposed = true
      // 作废所有在途请求：回来也不会再写状态。
      generation += 1
    }
  }
}
