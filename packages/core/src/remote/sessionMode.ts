import { ALL_PERMISSIONS, ErrorCode, PetError } from '@pet/shared'
import type { Permission } from '@pet/shared'
import type { PermissionBroker } from '../modules/permissionBroker.js'

/**
 * 会话模式：先决定「谁在说话」，再决定「她此刻能做什么」。
 *
 * 同一条 QQ 消息，来自主人私聊还是群友，工具面必须不同。
 * 这层不替代 PermissionBroker，而是它的输入源：模式 → 权限集 → broker.replace()。
 *
 * - `chat`：群友场景。能渲染、能读记忆，不能写记忆、不能联网、不能替你拍板。
 * - `closed-agent`：主人私聊。完整权限，对应「在 QQ 上远程指挥」。
 *
 * 默认 `chat`：没明确说「这是主人」之前，一律按最小集处理。
 */
export type SessionMode = 'chat' | 'closed-agent'

/** 切换原因。自动降权要和手动切换分开记，否则事后分不清是忘了还是系统收的。 */
export type SwitchReason = 'manual' | 'idle-timeout'

/**
 * 每种模式的权限集。
 *
 * `chat` 刻意不给这三项：
 * - `dsh.decision.commit` —— 群友不能替主人拍板
 * - `memory.write` —— 群聊内容不应自动进长期记忆
 * - `net.egress` —— 群友触发的出网请求没有可信来源
 */
const MODE_PERMISSIONS: Readonly<Record<SessionMode, readonly Permission[]>> = {
  chat: ['ui.render', 'ui.panel', 'memory.read'],
  'closed-agent': ALL_PERMISSIONS
}

const KNOWN_MODES: readonly SessionMode[] = ['chat', 'closed-agent']

/** 提权后多久没动静就自动降回 chat。0 或负数表示不启用。 */
const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60_000

export function isSessionMode(value: string): value is SessionMode {
  return (KNOWN_MODES as readonly string[]).includes(value)
}

/**
 * 未知模式直接抛错，不回退到任何默认集。
 *
 * 这里必须硬失败：把拼错的模式名悄悄当成 `chat` 会让权限静默降级，
 * 当成 `closed-agent` 则是更糟的提权。
 */
export function permissionsForMode(mode: SessionMode): readonly Permission[] {
  if (!isSessionMode(mode)) {
    throw new PetError(ErrorCode.INVALID_ARGUMENT, `未知会话模式：${String(mode)}`)
  }
  return MODE_PERMISSIONS[mode]
}

export interface ModeSwitchEntry {
  readonly from: SessionMode | null
  readonly to: SessionMode
  readonly at: number
  readonly reason: SwitchReason
}

export interface SessionModeGateOptions {
  readonly broker: PermissionBroker
  readonly initial?: SessionMode
  readonly now?: () => number
  /** 提权后的空闲降权窗口，默认 5 分钟；0 关闭。 */
  readonly idleTimeoutMs?: number
}

/**
 * 会话模式闸门。
 *
 * 切换模式时用 `replace()` 覆盖式下发：升权与降权走同一条路径，
 * 从 `closed-agent` 切回 `chat` 时多余权限会被逐项收回并留审计。
 *
 * 提权是有代价的状态，所以带空闲降权：切过去之后长时间没人说话，
 * 下一轮 `tick()` 会自己收回来，不需要谁记得手动切。
 */
export class SessionModeGate {
  private readonly broker: PermissionBroker
  private readonly now: () => number
  private readonly idleTimeoutMs: number
  private readonly history: ModeSwitchEntry[] = []
  private readonly listeners = new Set<(entry: ModeSwitchEntry) => void>()
  private modeValue: SessionMode
  private lastActivityAt: number

  constructor(options: SessionModeGateOptions) {
    this.broker = options.broker
    this.now = options.now ?? Date.now
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
    this.modeValue = options.initial ?? 'chat'
    this.lastActivityAt = this.now()

    // 构造时就把初始模式的权限下发，避免出现「已切模式但权限还是旧的」空窗。
    this.broker.replace(permissionsForMode(this.modeValue))
    this.history.push({
      from: null,
      to: this.modeValue,
      at: this.lastActivityAt,
      reason: 'manual'
    })
  }

  get mode(): SessionMode {
    return this.modeValue
  }

  get idleMs(): number {
    return this.now() - this.lastActivityAt
  }

  /** 当前模式是否允许某权限。给运行时裁决用，不抛错。 */
  can(permission: Permission): boolean {
    return this.broker.has(permission)
  }

  /** 记录一次活动，把空闲计时归零。每收到一条属于主人的消息调一次。 */
  touch(now: number = this.now()): void {
    this.lastActivityAt = now
  }

  /**
   * 宿主定时调用：检查是否该自动降权。
   *
   * 返回 true 表示这一轮发生了降权，调用方可以据此提示一句。
   * 不在类内部起定时器，是为了让测试完全可控，不依赖真实时钟。
   */
  tick(now: number = this.now()): boolean {
    if (this.idleTimeoutMs <= 0) return false
    if (this.modeValue !== 'closed-agent') return false
    if (now - this.lastActivityAt < this.idleTimeoutMs) return false
    this.switchTo('chat', 'idle-timeout')
    return true
  }

  /**
   * 切换模式。
   *
   * 同一模式重复切换直接返回，不产生重复审计项——
   * 高频轮询里反复写「chat → chat」会把真正的切换淹掉。
   */
  switchTo(mode: SessionMode, reason: SwitchReason = 'manual'): void {
    if (!isSessionMode(mode)) {
      throw new PetError(ErrorCode.INVALID_ARGUMENT, `未知会话模式：${String(mode)}`)
    }
    if (mode === this.modeValue) return

    const from = this.modeValue
    this.modeValue = mode
    this.lastActivityAt = this.now()
    this.broker.replace(permissionsForMode(mode))

    const entry: ModeSwitchEntry = { from, to: mode, at: this.lastActivityAt, reason }
    this.history.push(entry)
    for (const listener of this.listeners) listener(entry)
  }

  /** 订阅模式切换。返回取消函数。 */
  onChange(listener: (entry: ModeSwitchEntry) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  audit(): readonly ModeSwitchEntry[] {
    return [...this.history]
  }

  snapshot(): { readonly mode: SessionMode; readonly permissions: readonly Permission[] } {
    return { mode: this.modeValue, permissions: this.broker.snapshot() }
  }
}
