import { DshBridge } from '@pet/core'
import type {
  ApprovalRequest,
  AskRequest,
  AskResponse,
  HostAdapter,
  HostCapabilitySnapshot,
  TaskProgress
} from '@pet/core'

/** 宿主能力的实际接线点：由 Electron 主进程按可用接口逐项填入。 */
export interface HostAdapterWiring {
  readonly ask?: (request: AskRequest) => Promise<AskResponse>
  readonly approve?: (request: ApprovalRequest) => Promise<boolean>
  readonly reportTask?: (progress: TaskProgress) => void
}

export function createHostAdapter(version: string, wiring: HostAdapterWiring = {}): HostAdapter {
  return {
    version,
    ...(wiring.ask === undefined ? {} : { ask: wiring.ask }),
    ...(wiring.approve === undefined ? {} : { approve: wiring.approve }),
    ...(wiring.reportTask === undefined ? {} : { reportTask: wiring.reportTask })
  }
}

/**
 * 把宿主接线交给 core 的能力探测。
 * 缺失的能力不会在启动时报错，而是在第一次调用时统一降级为 NOT_SUPPORTED。
 */
export function createDesktopBridge(
  version: string,
  wiring: HostAdapterWiring = {},
  snapshot?: HostCapabilitySnapshot
): DshBridge {
  return DshBridge.connect(createHostAdapter(version, wiring), snapshot)
}
