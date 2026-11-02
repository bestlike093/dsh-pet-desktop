/**
 * 子任务调度。
 *
 * 规则来自实际踩过的坑：
 *
 * - 同一位黄金裔在一段对话里只保留一个上下文，再派活时接在原上下文
 * - 只读任务可以并行，写入任务必须排队
 * - 每个子任务有自己的步数预算，超了就停，不能无限挖下去
 *
 * 对应能力：`agent.subagent`。
 */

export type TaskKind = 'read-only' | 'write'

export interface SubagentTask<TInput = unknown> {
  readonly id: string
  /** 黄金裔的标识，比如 `fengjin`。 */
  readonly companionId: string
  readonly kind: TaskKind
  readonly input: TInput
  readonly budget?: number
}

export interface SubagentHandle {
  readonly taskId: string
  readonly companionId: string
  /** 复用了已有上下文时为 `true`。 */
  readonly reused: boolean
  readonly slot: number
}

export class SubagentError extends Error {
  readonly reason: 'no-slot' | 'companion-closed' | 'duplicate' | 'budget'

  constructor(reason: SubagentError['reason'], message: string) {
    super(message)
    this.name = 'SubagentError'
    this.reason = reason
  }
}

interface CompanionContext {
  readonly companionId: string
  readonly taskIds: string[]
  open: boolean
}

export interface SchedulerOptions {
  /** 同时能跑几个只读任务，默认 3。 */
  readonly maxConcurrentRead?: number
  /** 每个任务的默认步数预算。 */
  readonly defaultBudget?: number
}

/**
 * 子任务调度器。
 *
 * 只管「谁能在什么时候开始」，不真的执行任务。
 * 执行交给宿主，完成时调用 `finish`。
 */
export class SubagentScheduler {
  private readonly contexts = new Map<string, CompanionContext>()
  private readonly running = new Set<string>()
  private readonly maxConcurrentRead: number
  private readonly defaultBudget: number
  private writing: string | null = null

  constructor(options: SchedulerOptions = {}) {
    this.maxConcurrentRead = options.maxConcurrentRead ?? 3
    this.defaultBudget = options.defaultBudget ?? 40
  }

  /** 派一个任务。返回句柄，宿主据此去执行。 */
  claim(task: SubagentTask): SubagentHandle {
    if (this.running.has(task.id)) {
      throw new SubagentError('duplicate', `任务 ${task.id} 已经在跑了`)
    }

    const existing = this.contexts.get(task.companionId)
    if (existing !== undefined && !existing.open) {
      throw new SubagentError('companion-closed', `${task.companionId} 的上下文已关闭`)
    }

    // 写入任务独占：同一时刻只允许一个写任务
    if (task.kind === 'write') {
      if (this.writing !== null) {
        throw new SubagentError('no-slot', `写入任务 ${this.writing} 还没结束`)
      }
      if (this.running.size > 0) {
        throw new SubagentError('no-slot', '还有任务在跑，写入任务要等它们结束')
      }
      this.writing = task.id
    } else {
      const readCount = this.countReads()
      if (readCount >= this.maxConcurrentRead) {
        throw new SubagentError('no-slot', `只读任务已达上限 ${this.maxConcurrentRead}`)
      }
      if (this.writing !== null) {
        throw new SubagentError('no-slot', '写入任务进行中，只读任务先等一下')
      }
    }

    const reused = existing !== undefined
    const context: CompanionContext = existing ?? {
      companionId: task.companionId,
      taskIds: [],
      open: true
    }
    context.taskIds.push(task.id)
    this.contexts.set(task.companionId, context)
    this.running.add(task.id)

    return {
      taskId: task.id,
      companionId: task.companionId,
      reused,
      slot: this.running.size
    }
  }

  /** 任务结束（成功或失败都算）。 */
  finish(taskId: string): void {
    this.running.delete(taskId)
    if (this.writing === taskId) this.writing = null
  }

  /** 关闭某个角色，释放它的上下文。之后派活会创建新上下文。 */
  close(companionId: string): void {
    const context = this.contexts.get(companionId)
    if (context === undefined) return
    context.open = false
    for (const taskId of context.taskIds) this.running.delete(taskId)
    if (this.writing !== null && context.taskIds.includes(this.writing)) {
      this.writing = null
    }
  }

  /** 当前有几个任务在跑。 */
  get activeCount(): number {
    return this.running.size
  }

  /** 某个角色是否还开着上下文。 */
  isOpen(companionId: string): boolean {
    return this.contexts.get(companionId)?.open ?? false
  }

  /** 这个角色的上下文里跑过哪些任务。 */
  historyOf(companionId: string): readonly string[] {
    return this.contexts.get(companionId)?.taskIds ?? []
  }

  /**
   * 把任务切成一串批，按顺序跑。
   *
   * 同一批里都是只读，可以并行；遇到写任务单独成批。
   */
  plan(tasks: readonly SubagentTask[]): readonly (readonly SubagentTask[])[] {
    const batches: SubagentTask[][] = []
    let current: SubagentTask[] = []

    for (const task of tasks) {
      if (task.kind === 'write') {
        if (current.length > 0) {
          batches.push(current)
          current = []
        }
        batches.push([task])
        continue
      }
      current.push(task)
      if (current.length >= this.maxConcurrentRead) {
        batches.push(current)
        current = []
      }
    }

    if (current.length > 0) batches.push(current)
    return batches
  }

  /** 预算检查：步数用完了没有。 */
  overBudget(task: SubagentTask, usedSteps: number): boolean {
    const limit = task.budget ?? this.defaultBudget
    return usedSteps >= limit
  }

  private countReads(): number {
    let count = 0
    for (const id of this.running) {
      if (id !== this.writing) count += 1
    }
    return count
  }
}
