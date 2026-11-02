import { ErrorCode, PetError } from '@pet/shared'
import type {
  ApprovalRequest,
  AskRequest,
  AskResponse,
  HostAdapter,
  HostCapability,
  HostCapabilitySnapshot,
  TaskProgress
} from '@pet/shared'

/** 宿主能力快照。只有这里为 true 的能力，上层才允许调用对应接口。 */
export interface DshCapabilities {
  readonly version: string
  readonly ask: boolean
  readonly approval: boolean
  readonly taskProgress: boolean
  readonly settings: boolean
  readonly tray: boolean
  readonly window: boolean
}

/**
 * 宿主调用契约已上移到 `@pet/shared` 的 contracts/host.ts，
 * 与 `IHostAdapter` / `HostCapabilitySnapshot` 共用同一份定义；
 * 此处 re-export 保持既有导入路径可用。
 */
export type { ApprovalRequest, AskRequest, AskResponse, HostAdapter, TaskProgress }

const FALLBACK_VERSION = '0.0.0-unknown'

/**
 * 能力判定以宿主真实声明为准。
 *
 * 传了 `HostCapabilitySnapshot` 就完全按 `available` 判定；
 * 没传时只能按宿主对象上的实际方法探测，`settings` / `tray` / `window`
 * 在 `HostAdapter` 契约里没有对应方法，一律 fail-closed，不再硬编码 true。
 */
function detect(
  host: HostAdapter | undefined,
  snapshot: HostCapabilitySnapshot | undefined
): DshCapabilities {
  const version = snapshot?.version ?? host?.version ?? FALLBACK_VERSION
  if (host === undefined) {
    return {
      version,
      ask: false,
      approval: false,
      taskProgress: false,
      settings: false,
      tray: false,
      window: false
    }
  }

  const declared = snapshot === undefined ? undefined : new Set<HostCapability>(snapshot.available)
  const supports = (cap: HostCapability, fallback: boolean): boolean =>
    declared === undefined ? fallback : declared.has(cap)
  const extended = host as unknown as Record<string, unknown>

  return {
    version,
    ask: supports('ask', typeof host.ask === 'function') && typeof host.ask === 'function',
    approval:
      supports('approval', typeof host.approve === 'function') && typeof host.approve === 'function',
    taskProgress:
      supports('taskProgress', typeof host.reportTask === 'function') &&
      typeof host.reportTask === 'function',
    settings: supports('settings', typeof extended.openSettings === 'function'),
    tray: supports('tray', typeof extended.showTray === 'function'),
    window: supports('window', typeof extended.getWindow === 'function')
  }
}

/**
 * 全项目唯一允许接触宿主的入口。
 * 宿主缺失时统一降级为 NOT_SUPPORTED，而不是抛底层错误让调用方崩掉。
 */
export class DshBridge {
  private readonly host: HostAdapter | undefined
  private readonly caps: DshCapabilities

  private constructor(
    host: HostAdapter | undefined,
    snapshot: HostCapabilitySnapshot | undefined
  ) {
    this.host = host
    this.caps = detect(host, snapshot)
  }

  static connect(host?: HostAdapter, snapshot?: HostCapabilitySnapshot): DshBridge {
    return new DshBridge(host, snapshot)
  }

  capabilities(): DshCapabilities {
    return this.caps
  }

  isAvailable(cap: Exclude<keyof DshCapabilities, 'version'>): boolean {
    return this.caps[cap]
  }

  async ask(request: AskRequest): Promise<AskResponse> {
    if (this.host?.ask === undefined) {
      throw new PetError(ErrorCode.NOT_SUPPORTED, '宿主未提供提问接管')
    }
    return this.host.ask(request)
  }

  async approve(request: ApprovalRequest): Promise<boolean> {
    if (this.host?.approve === undefined) {
      throw new PetError(ErrorCode.NOT_SUPPORTED, '宿主未提供审批接管')
    }
    return this.host.approve(request)
  }

  reportTask(progress: TaskProgress): void {
    this.host?.reportTask?.(progress)
  }

  /** 诊断面板用：把能力快照压成一行，方便贴日志。 */
  describe(): string {
    const c = this.caps
    const flags = [
      c.ask ? 'ask' : '',
      c.approval ? 'approval' : '',
      c.taskProgress ? 'taskProgress' : '',
      c.settings ? 'settings' : '',
      c.tray ? 'tray' : '',
      c.window ? 'window' : ''
    ].filter(Boolean)
    return `dsh ${c.version} [${flags.join(',') || 'none'}]`
  }
}
