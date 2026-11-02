import { ErrorCode, PetError } from '@pet/shared'

export interface SchedulerOptions {
  readonly setTimeoutFn?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  readonly clearTimeoutFn?: (handle: ReturnType<typeof setTimeout>) => void
}

/** 指数退避：第 1 次 baseMs，之后翻倍，封顶 maxMs。 */
export function backoffDelay(attempt: number, baseMs = 250, maxMs = 30_000): number {
  const safeAttempt = Math.max(1, Math.trunc(attempt))
  return Math.min(maxMs, baseMs * 2 ** (safeAttempt - 1))
}

/**
 * 可取消调度器。
 * 所有定时器都登记在表里，dispose 时一次性清空，避免模块卸载后回调继续跑。
 */
export class Scheduler {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly setTimeoutFn: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  private readonly clearTimeoutFn: (handle: ReturnType<typeof setTimeout>) => void
  private sequence = 0

  constructor(options: SchedulerOptions = {}) {
    this.setTimeoutFn = options.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimeoutFn = options.clearTimeoutFn ?? ((handle) => clearTimeout(handle))
  }

  get size(): number {
    return this.timers.size
  }

  schedule(delayMs: number, fn: () => void): string {
    const delay = Math.max(0, Math.trunc(delayMs))
    this.sequence += 1
    const id = `task-${this.sequence}`
    const handle = this.setTimeoutFn(() => {
      this.timers.delete(id)
      fn()
    }, delay)
    this.timers.set(id, handle)
    return id
  }

  cancel(id: string): boolean {
    const handle = this.timers.get(id)
    if (handle === undefined) return false
    this.clearTimeoutFn(handle)
    this.timers.delete(id)
    return true
  }

  clear(): void {
    for (const handle of this.timers.values()) this.clearTimeoutFn(handle)
    this.timers.clear()
  }

  /** 超时即抛 LOAD_TIMEOUT，且不会留下悬挂定时器。 */
  runWithTimeout<T>(fn: () => Promise<T>, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false
      const handle = this.setTimeoutFn(() => {
        if (settled) return
        settled = true
        reject(new PetError(ErrorCode.LOAD_TIMEOUT, `模块执行超时（${timeoutMs}ms）`))
      }, Math.max(0, Math.trunc(timeoutMs)))

      fn().then(
        (value) => {
          if (settled) return
          settled = true
          this.clearTimeoutFn(handle)
          resolve(value)
        },
        (error: unknown) => {
          if (settled) return
          settled = true
          this.clearTimeoutFn(handle)
          reject(error)
        }
      )
    })
  }
}
