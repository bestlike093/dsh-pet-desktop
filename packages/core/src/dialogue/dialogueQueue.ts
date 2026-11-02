/**
 * 台词队列：S5 的容器，打断与优先级都落在这里。
 *
 * 只负责排序、出队与状态迁移；播放、情绪、配额都在外层。
 * 优先级从高到低：approval > interrupt > normal > idle。
 *
 * 命名说明：`'interrupt'` 是一个优先级档位；`interrupt()` 是清理动作。
 * 两者没有调用关系——`interrupt()` 只停止当前并清空待播，绝不再插入台词，
 * 否则新插入的 `'interrupt'` 条目会被下一次打断清掉，形成递归。
 */

export type DialoguePriority = 'idle' | 'normal' | 'interrupt' | 'approval'

const PRIORITY_WEIGHT: Readonly<Record<DialoguePriority, number>> = {
  idle: 0,
  normal: 1,
  interrupt: 2,
  approval: 3
}

export interface DialogueItem {
  readonly id: string
  readonly text: string
  readonly priority: DialoguePriority
  readonly createdAt: number
}

export interface EnqueueInput {
  readonly text: string
  readonly priority: DialoguePriority
  /** 调用方需要稳定引用时可自带；缺省用队列自增 id。 */
  readonly id?: string
  readonly createdAt?: number
}

/** 三态分开：播完、被中断、被丢弃，下游据此推进状态机。 */
export type DialogueOutcome = 'completed' | 'interrupted' | 'dropped'

export interface DialogueQueueListeners {
  /** 只在正常播完时触发；中断路径不会调用。 */
  readonly onComplete?: (item: DialogueItem) => void
  /** 正在播的那条被打断时触发。 */
  readonly onInterrupted?: (item: DialogueItem) => void
  /** 待播台词被清掉时逐条触发。 */
  readonly onDropped?: (item: DialogueItem) => void
}

export interface DialogueQueueOptions {
  /** 便于测试注入固定时钟。 */
  readonly now?: () => number
  readonly listeners?: DialogueQueueListeners
}

export interface InterruptResult {
  /** 被打断的当前条目；没有在播时为 undefined。 */
  readonly interrupted: DialogueItem | undefined
  /** 本次清掉的待播条数。 */
  readonly dropped: number
  /** 累计丢弃数，用于诊断归因。 */
  readonly droppedCount: number
}

export class DialogueQueue {
  private readonly items: DialogueItem[] = []
  private readonly now: () => number
  private readonly listeners: DialogueQueueListeners
  private sequence = 0
  private current: DialogueItem | undefined
  private disposed = false
  private dropped = 0

  constructor(options: DialogueQueueOptions = {}) {
    this.now = options.now ?? Date.now
    this.listeners = options.listeners ?? {}
  }

  get size(): number {
    return this.items.length
  }

  get currentItem(): DialogueItem | undefined {
    return this.current
  }

  get droppedCount(): number {
    return this.dropped
  }

  get isDisposed(): boolean {
    return this.disposed
  }

  enqueue(input: EnqueueInput): DialogueItem | undefined {
    if (this.disposed) return undefined

    this.sequence += 1

    const item: DialogueItem = {
      id: input.id ?? `line-${this.sequence}`,
      text: input.text,
      priority: input.priority,
      createdAt: input.createdAt ?? this.now()
    }

    this.items.push(item)
    return item
  }

  /** 取最高优先级的最早一条；同级按入队顺序。 */
  dequeue(): DialogueItem | undefined {
    if (this.disposed || this.items.length === 0) return undefined

    let bestIndex = 0
    for (let index = 1; index < this.items.length; index += 1) {
      if (PRIORITY_WEIGHT[this.items[index]!.priority] > PRIORITY_WEIGHT[this.items[bestIndex]!.priority]) {
        bestIndex = index
      }
    }

    const [item] = this.items.splice(bestIndex, 1)
    return item
  }

  peek(): DialogueItem | undefined {
    if (this.disposed || this.items.length === 0) return undefined

    let best = this.items[0]!
    for (const item of this.items) {
      if (PRIORITY_WEIGHT[item.priority] > PRIORITY_WEIGHT[best.priority]) best = item
    }
    return best
  }

  /** 把下一条设为「正在播」；已经在播时直接返回当前条目。 */
  beginNext(): DialogueItem | undefined {
    if (this.disposed) return undefined
    if (this.current !== undefined) return this.current

    this.current = this.dequeue()
    return this.current
  }

  /** 正常播完：清当前并触发 onComplete。 */
  complete(): DialogueItem | undefined {
    if (this.disposed) return undefined

    const item = this.current
    if (item === undefined) return undefined

    this.current = undefined
    this.listeners.onComplete?.(item)
    return item
  }

  /**
   * 打断：停止当前 + 清掉所有非 approval 的待播。
   *
   * 只做清理，不产生任何新条目。空队列、重复调用、已 dispose 都是 no-op。
   */
  interrupt(): InterruptResult {
    if (this.disposed) {
      return { interrupted: undefined, dropped: 0, droppedCount: this.dropped }
    }

    const interrupted = this.current
    this.current = undefined

    if (interrupted !== undefined) {
      this.listeners.onInterrupted?.(interrupted)
    }

    const kept = this.items.filter((item) => item.priority === 'approval')
    const droppedItems = this.items.filter((item) => item.priority !== 'approval')

    this.items.length = 0
    this.items.push(...kept)

    this.dropped += droppedItems.length
    for (const item of droppedItems) {
      this.listeners.onDropped?.(item)
    }

    return { interrupted, dropped: droppedItems.length, droppedCount: this.dropped }
  }

  /**
   * 清空待播：与 interrupt 共用同一套丢弃记账。
   *
   * 清掉的每一条都计入 dropped 并逐条触发 onDropped；静默清空会让下游
   * 状态机停在「还以为在排队」的位置。
   */
  clear(): void {
    if (this.disposed) return

    const droppedItems = [...this.items]
    this.items.length = 0

    this.dropped += droppedItems.length
    for (const item of droppedItems) {
      this.listeners.onDropped?.(item)
    }
  }

  /** 只读快照，按当前队列顺序，不改动内部状态。 */
  snapshot(): readonly DialogueItem[] {
    return [...this.items]
  }

  /**
   * 终态：清空并释放，之后 enqueue / interrupt 全部 no-op。
   *
   * 在播条目与待播条目一起归入 dropped 并逐条触发 onDropped。
   * 不新增「被 dispose 丢弃」这一态：下游只需处理 completed / interrupted / dropped。
   * 重复调用是 no-op，不会重复计数。
   */
  dispose(): void {
    if (this.disposed) return

    // 先置位，回调里再想入队也会被挡住。
    this.disposed = true

    const droppedItems: DialogueItem[] = []

    if (this.current !== undefined) {
      droppedItems.push(this.current)
      this.current = undefined
    }

    for (const item of this.items) {
      droppedItems.push(item)
    }
    this.items.length = 0

    this.dropped += droppedItems.length
    for (const item of droppedItems) {
      this.listeners.onDropped?.(item)
    }
  }
}
