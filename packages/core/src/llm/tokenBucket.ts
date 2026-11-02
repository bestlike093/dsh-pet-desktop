/**
 * TokenBucket：按 provider 一个桶。
 *
 * 运行期补桶用单调时钟（performance.now），避免 NTP 校正、改系统时间、
 * 休眠唤醒把桶瞬间充满或让 tokens 倒退。
 *
 * 持久化用墙上时钟记录 lastRefillWallMs：跨进程只有墙上时间可比，
 * 恢复时按经过时长折算补桶，不重置为满桶。
 */

export type ConsumeFailReason = 'insufficient' | 'exceeds-capacity'

export type ConsumeResult =
  | { readonly ok: true; readonly tokens: number }
  | { readonly ok: false; readonly reason: ConsumeFailReason; readonly tokens: number }

export interface TokenBucketOptions {
  readonly capacity: number
  /** 每毫秒补充的 token 数；0 表示不自动补。 */
  readonly refillPerMs: number
  readonly initialTokens?: number
  /** 单调时钟，运行期补桶用；测试可注入。 */
  readonly now?: () => number
  /** 墙上时钟，只用于持久化折算。 */
  readonly wallNow?: () => number
}

export interface BucketSnapshot {
  readonly providerId: string
  readonly capacity: number
  readonly tokens: number
  /** 单调时钟下的上次补桶时刻。 */
  readonly lastRefillMs: number
  /** 墙上时钟下的上次补桶时刻。 */
  readonly lastRefillWallMs: number
}

export interface PersistedBucketState {
  readonly providerId: string
  readonly tokens: number
  readonly lastRefillWallMs: number
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export class TokenBucket {
  readonly providerId: string
  readonly capacity: number
  readonly refillPerMs: number

  private readonly now: () => number
  private readonly wallNow: () => number
  private tokensValue: number
  private lastRefillMsValue: number
  private lastRefillWallMsValue: number

  constructor(providerId: string, options: TokenBucketOptions) {
    this.providerId = providerId
    this.capacity = Math.max(0, options.capacity)
    this.refillPerMs = Math.max(0, options.refillPerMs)
    this.now = options.now ?? (() => performance.now())
    this.wallNow = options.wallNow ?? Date.now

    this.tokensValue = clamp(options.initialTokens ?? this.capacity, 0, this.capacity)
    this.lastRefillMsValue = this.now()
    this.lastRefillWallMsValue = this.wallNow()
  }

  get tokens(): number {
    this.refill(this.now())
    return this.tokensValue
  }

  /**
   * 单次原子扣减：补桶、判定、扣减在同一个同步调用里完成。
   *
   * 返回 false 时不抛异常；`reason` 区分「暂时不够」与「这个请求永远不可能满足」，
   * 后者调用方不应重试。
   */
  tryConsume(amount = 1, now = this.now()): ConsumeResult {
    this.refill(now)

    if (amount > this.capacity) {
      return { ok: false, reason: 'exceeds-capacity', tokens: this.tokensValue }
    }

    if (this.tokensValue < amount) {
      return { ok: false, reason: 'insufficient', tokens: this.tokensValue }
    }

    this.tokensValue -= amount
    return { ok: true, tokens: this.tokensValue }
  }

  /**
   * 事后结算：正数把预扣多出来的部分还回桶里，
   * 负数用于补扣实际用量超过预扣的差额，下限仍然是 0。
   */
  refund(amount: number): number {
    this.refill(this.now())

    if (amount !== 0) {
      this.tokensValue = clamp(this.tokensValue + amount, 0, this.capacity)
    }

    return this.tokensValue
  }

  snapshot(): BucketSnapshot {
    this.refill(this.now())

    return {
      providerId: this.providerId,
      capacity: this.capacity,
      tokens: Math.round(this.tokensValue * 1000) / 1000,
      lastRefillMs: this.lastRefillMsValue,
      lastRefillWallMs: this.lastRefillWallMsValue
    }
  }

  serialize(): PersistedBucketState {
    this.refill(this.now())

    return {
      providerId: this.providerId,
      tokens: this.tokensValue,
      lastRefillWallMs: this.lastRefillWallMsValue
    }
  }

  /** 按墙上时钟的经过时长折算补桶，而不是重置为满桶。 */
  static restore(
    providerId: string,
    options: TokenBucketOptions,
    state: PersistedBucketState
  ): TokenBucket {
    const wallNow = options.wallNow ?? Date.now
    const elapsedMs = Math.max(0, wallNow() - state.lastRefillWallMs)
    const refilled = state.tokens + elapsedMs * Math.max(0, options.refillPerMs)

    return new TokenBucket(providerId, {
      ...options,
      initialTokens: clamp(refilled, 0, Math.max(0, options.capacity))
    })
  }

  /**
   * 时钟倒退时直接跳过本次补桶：tokens 不减、不抛错。
   * 顺时针向前才按差值补，且不超过容量。
   */
  private refill(now: number): void {
    if (now <= this.lastRefillMsValue) return

    const elapsed = now - this.lastRefillMsValue
    this.tokensValue = clamp(this.tokensValue + elapsed * this.refillPerMs, 0, this.capacity)
    this.lastRefillMsValue = now
    this.lastRefillWallMsValue = this.wallNow()
  }
}

/**
 * 按 provider 身份持桶：切换 provider 不会重置原桶。
 * 所有能让桶变满的操作都是可绕过点，这里只复用，不重建。
 */
export class TokenBucketRegistry {
  private readonly buckets = new Map<string, TokenBucket>()
  private readonly defaultOptions: TokenBucketOptions

  constructor(defaultOptions: TokenBucketOptions) {
    this.defaultOptions = defaultOptions
  }

  get(providerId: string, options: Partial<TokenBucketOptions> = {}): TokenBucket {
    const existing = this.buckets.get(providerId)
    if (existing !== undefined) return existing

    const bucket = new TokenBucket(providerId, { ...this.defaultOptions, ...options })
    this.buckets.set(providerId, bucket)
    return bucket
  }

  restore(providerId: string, state: PersistedBucketState, options: Partial<TokenBucketOptions> = {}): TokenBucket {
    const bucket = TokenBucket.restore(providerId, { ...this.defaultOptions, ...options }, state)
    this.buckets.set(providerId, bucket)
    return bucket
  }

  snapshotAll(): readonly BucketSnapshot[] {
    return [...this.buckets.values()].map((bucket) => bucket.snapshot())
  }
}
