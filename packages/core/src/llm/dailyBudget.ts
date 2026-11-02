/**
 * DailyBudgetGate：按本地自然日累计的消费额度。
 *
 * 与 TokenBucket 分工不同：
 * - TokenBucket 管「短时间内的速率」，防止瞬时把 provider 打爆；
 * - 这里管「一天总共能花多少」，防止长时间缓慢烧穿余额。
 *
 * 跨日按本地日期键滚动，而不是固定 24 小时：用户理解的「今天」是日历上的今天，
 * 不是「距离上次重置满 24 小时」。
 *
 * 额度单位由调用方决定（token 或折算后的计价点数），本类只做累加与判定。
 */

export type BudgetLevel = 'ok' | 'warn' | 'exhausted'

export interface DailyBudgetOptions {
  /** 每日上限，0 表示不限制。 */
  readonly dailyLimit: number
  /** 预警占比，默认 0.8；超出范围会被夹到 (0, 1]。 */
  readonly warnRatio?: number
  /** 恢复持久化状态时的初始已用额度。 */
  readonly initialUsed?: number
  /** 恢复持久化状态时的日期键；缺省取当前本地日期。 */
  readonly initialDayKey?: string
  /** 墙上时钟，测试可注入。 */
  readonly now?: () => number
}

export type BudgetVerdict =
  | { readonly allowed: true; readonly remaining: number }
  | {
      readonly allowed: false
      readonly reason: 'limit-reached'
      readonly used: number
      readonly limit: number
    }

export interface BudgetStatus {
  readonly dayKey: string
  readonly used: number
  readonly limit: number
  /** 不限额时为 Infinity，调用方用 Number.isFinite 判断是否展示。 */
  readonly remaining: number
  /** used / limit，保留三位小数；不限额时为 0。 */
  readonly ratio: number
  readonly level: BudgetLevel
}

export interface PersistedBudgetState {
  readonly dayKey: string
  readonly used: number
}

function clampRatio(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0.8
  return Math.min(1, value)
}

function normalizeAmount(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0
  return value
}

/** 本地日期键 YYYY-MM-DD。用本地时区，跨日点与用户直觉一致。 */
export function localDayKey(at: number): string {
  const date = new Date(at)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * 每日额度闸门。
 *
 * 典型用法：
 * ```ts
 * if (!gate.canSpend(estimate).allowed) return // 先拦住，不发起请求
 * const result = await callModel()
 * gate.record(result.usage.totalTokens)       // 事后按真实用量结算
 * ```
 *
 * `canSpend` 不扣减，允许同一轮里多次预检；真正的扣减只发生在 `record`。
 */
export class DailyBudgetGate {
  private readonly dailyLimit: number
  private readonly warnRatio: number
  private readonly now: () => number
  private usedValue: number
  private dayKeyValue: string

  constructor(options: DailyBudgetOptions) {
    this.dailyLimit = Math.max(0, Number.isFinite(options.dailyLimit) ? options.dailyLimit : 0)
    this.warnRatio = clampRatio(options.warnRatio ?? 0.8)
    this.now = options.now ?? Date.now
    this.dayKeyValue = options.initialDayKey ?? localDayKey(this.now())
    this.usedValue = normalizeAmount(options.initialUsed ?? 0)
    this.rollIfNeeded()
  }

  get limit(): number {
    return this.dailyLimit
  }

  get used(): number {
    this.rollIfNeeded()
    return this.usedValue
  }

  get dayKey(): string {
    this.rollIfNeeded()
    return this.dayKeyValue
  }

  /** 预检：估计要花 estimated 时还能不能继续。不扣减。 */
  canSpend(estimated = 0): BudgetVerdict {
    this.rollIfNeeded()

    if (this.dailyLimit === 0) {
      return { allowed: true, remaining: Number.POSITIVE_INFINITY }
    }

    const amount = normalizeAmount(estimated)
    const remaining = Math.max(0, this.dailyLimit - this.usedValue)

    // 额度恰好用完也算耗尽：此时再发起任何请求都不该放行。
    if (this.usedValue >= this.dailyLimit || this.usedValue + amount > this.dailyLimit) {
      return {
        allowed: false,
        reason: 'limit-reached',
        used: this.usedValue,
        limit: this.dailyLimit
      }
    }

    return { allowed: true, remaining: remaining - amount }
  }

  /**
   * 事后结算实际用量。
   *
   * 超额也照实记账，不夹到上限：看板需要知道「超了多少」，
   * 夹断会让真实消费在账面上凭空消失。
   */
  record(amount: number): BudgetStatus {
    this.rollIfNeeded()

    const normalized = normalizeAmount(amount)
    if (normalized > 0) this.usedValue += normalized

    return this.status()
  }

  status(): BudgetStatus {
    this.rollIfNeeded()

    const limit = this.dailyLimit
    const ratio = limit === 0 ? 0 : this.usedValue / limit

    const level: BudgetLevel =
      limit === 0
        ? 'ok'
        : this.usedValue >= limit
          ? 'exhausted'
          : ratio >= this.warnRatio
            ? 'warn'
            : 'ok'

    return {
      dayKey: this.dayKeyValue,
      used: this.usedValue,
      limit,
      remaining: limit === 0 ? Number.POSITIVE_INFINITY : Math.max(0, limit - this.usedValue),
      ratio: Math.round(ratio * 1000) / 1000,
      level
    }
  }

  serialize(): PersistedBudgetState {
    this.rollIfNeeded()
    return { dayKey: this.dayKeyValue, used: this.usedValue }
  }

  /** 恢复：跨了日就在构造时清空，没跨日就接着累计。 */
  static restore(options: DailyBudgetOptions, state: PersistedBudgetState): DailyBudgetGate {
    return new DailyBudgetGate({
      ...options,
      initialDayKey: state.dayKey,
      initialUsed: state.used
    })
  }

  /** 只有日期键变化才清零；同一天内多次调用无副作用。 */
  private rollIfNeeded(): void {
    const today = localDayKey(this.now())
    if (today === this.dayKeyValue) return

    this.dayKeyValue = today
    this.usedValue = 0
  }
}
