import type { ModuleHost, ModuleRuntime } from '../modules/moduleHost.js'
import type { DiagnosticsSnapshot } from './diagnostics.js'
import { mountDiagnosticsPanel, type DiagnosticsPanelMount } from './panelDom.js'
import { createPanelController, type PanelController } from './panelState.js'

export interface PanelBootOptions {
  /** 宿主容器，必须在 startAll 之前就存在。 */
  readonly container: Element
  readonly host: ModuleHost
  /** 渲染进程里通常是一层 IPC 调用。 */
  readonly load: () => Promise<DiagnosticsSnapshot>
  readonly onRetry?: () => void
  readonly onCopy?: () => void
}

export interface PanelBoot {
  readonly mount: DiagnosticsPanelMount
  readonly controller: PanelController
  readonly statuses: readonly ModuleRuntime[]
}

/**
 * 诊断面板装配（17.2.18）。
 *
 * 顺序是硬约束：
 * 1. 建容器、挂 pending —— 必须早于 startAll，否则失败模块的占位卡无处可挂；
 * 2. startAll —— 此时 failed 集合与占位集合才可能相等；
 * 3. refresh —— 诊断结果带的是启动完成后的模块状态。
 *
 * 面板本身是最小可渲染单元：不依赖模块、不等待主题注入完成。
 */
export async function bootDiagnosticsPanel(options: PanelBootOptions): Promise<PanelBoot> {
  const mount = mountDiagnosticsPanel(options.container, {
    ...(options.onRetry === undefined ? {} : { onRetry: options.onRetry }),
    ...(options.onCopy === undefined ? {} : { onCopy: options.onCopy })
  })

  // 立即挂 pending，不等任何异步结果。
  mount.update({ kind: 'pending' })

  const statuses = await options.host.startAll()

  const controller = createPanelController({
    load: options.load,
    render: (status) => mount.update(status)
  })
  await controller.refresh()

  return { mount, controller, statuses }
}
