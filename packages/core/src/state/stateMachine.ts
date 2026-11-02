import { ErrorCode, PetError } from '@pet/shared'

export type PetState = 'idle' | 'talking' | 'dragging' | 'thinking' | 'sleeping'

export interface StateChange {
  readonly from: PetState
  readonly to: PetState
  readonly at: number
}

export type StateListener = (change: StateChange) => void

/** 状态转移表：只允许表内边，其余一律拒绝。 */
export const TRANSITIONS: Readonly<Record<PetState, readonly PetState[]>> = {
  idle: ['talking', 'dragging', 'thinking', 'sleeping'],
  talking: ['idle', 'dragging', 'thinking', 'sleeping'],
  dragging: ['idle', 'talking'],
  thinking: ['idle', 'talking', 'sleeping'],
  sleeping: ['idle', 'dragging']
}

export const ALL_STATES: readonly PetState[] = ['idle', 'talking', 'dragging', 'thinking', 'sleeping']

function isPetState(value: string): value is PetState {
  return (ALL_STATES as readonly string[]).includes(value)
}

/**
 * 桌宠状态机。
 * 非法转移既不改变状态、也不触发监听器，调用方拿到稳定错误码自行决定提示方式。
 */
export class PetStateMachine {
  private currentState: PetState
  private readonly listeners = new Set<StateListener>()
  private readonly now: () => number

  constructor(initial: PetState = 'idle', now: () => number = Date.now) {
    if (!isPetState(initial)) {
      throw new PetError(ErrorCode.INVALID_ARGUMENT, `未知状态：${String(initial)}`)
    }
    this.currentState = initial
    this.now = now
  }

  get state(): PetState {
    return this.currentState
  }

  can(to: PetState): boolean {
    return TRANSITIONS[this.currentState].includes(to)
  }

  /** 非法转移抛 INVALID_ARGUMENT；成功时返回这条转移记录。 */
  transition(to: PetState): StateChange {
    if (!isPetState(to)) {
      throw new PetError(ErrorCode.INVALID_ARGUMENT, `未知状态：${String(to)}`)
    }
    if (!this.can(to)) {
      throw new PetError(ErrorCode.INVALID_ARGUMENT, `非法状态转移：${this.currentState} → ${to}`, {
        details: { from: this.currentState, to }
      })
    }

    const change: StateChange = { from: this.currentState, to, at: this.now() }
    this.currentState = to
    for (const listener of [...this.listeners]) {
      try {
        listener(change)
      } catch {
        // 单个监听器失败不影响状态机本身
      }
    }
    return change
  }

  /** 不确定当前状态是否允许时用它，避免上层写 try/catch。 */
  tryTransition(to: PetState): StateChange | null {
    return this.can(to) ? this.transition(to) : null
  }

  onChange(listener: StateListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  reset(): void {
    this.currentState = 'idle'
  }
}
