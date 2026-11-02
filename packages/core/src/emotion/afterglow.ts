/**
 * 情绪余波：让情绪在事件结束后缓慢回落，而不是瞬间归零。
 *
 * 这是表现层的近似，不声称她真的有情绪。数值只影响下一次表情与台词的
 * 选择权重，不进入模型上下文，也不上传。
 *
 * 衰减用半衰期：经过一个 halfLifeMs，绝对值减半。读取时惰性结算，
 * 所以没有定时器也能正确衰减。
 */

export interface AfterglowSnapshot {
  /** 愉悦度，-1..1。 */
  readonly valence: number
  /** 唤醒度，0..1。 */
  readonly arousal: number
  readonly updatedAt: number
}

export interface AfterglowImpulse {
  readonly valence: number
  readonly arousal: number
}

export interface AfterglowOptions {
  readonly now?: () => number
  /** 关闭时 impulse 不生效，snapshot 永远是零值。 */
  readonly enabled?: boolean
  /** 半衰期，默认 30 分钟。 */
  readonly halfLifeMs?: number
  /** 一次刺激把当前值拉向目标的比例，0..1，默认 0.35。 */
  readonly weight?: number
  /** 低于这个绝对值就归零，避免无限趋近。 */
  readonly epsilon?: number
}

export const DEFAULT_AFTERGLOW_HALF_LIFE_MS = 30 * 60 * 1000
export const DEFAULT_AFTERGLOW_WEIGHT = 0.35
const DEFAULT_EPSILON = 0.01

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** 半衰期衰减：elapsed <= 0 时原样返回。 */
export function decayByHalfLife(value: number, elapsedMs: number, halfLifeMs: number): number {
  if (!Number.isFinite(value) || value === 0) return 0
  if (elapsedMs <= 0 || halfLifeMs <= 0) return value
  return value * 2 ** (-elapsedMs / halfLifeMs)
}

export class EmotionAfterglow {
  private readonly now: () => number
  private readonly halfLifeMs: number
  private readonly weight: number
  private readonly epsilon: number
  private enabled: boolean
  private valence = 0
  private arousal = 0
  private updatedAt: number

  constructor(options: AfterglowOptions = {}) {
    this.now = options.now ?? Date.now
    this.halfLifeMs = options.halfLifeMs ?? DEFAULT_AFTERGLOW_HALF_LIFE_MS
    this.weight = clamp(options.weight ?? DEFAULT_AFTERGLOW_WEIGHT, 0, 1)
    this.epsilon = options.epsilon ?? DEFAULT_EPSILON
    this.enabled = options.enabled ?? false
    this.updatedAt = this.now()
  }

  get isEnabled(): boolean {
    return this.enabled
  }

  /** 开关只影响后续行为；关闭时立刻清零，不保留残余。 */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled
    if (!enabled) this.reset()
  }

  /** 先结算到当前时刻，再按权重靠近目标值。 */
  impulse(input: AfterglowImpulse, weight = this.weight): AfterglowSnapshot {
    if (!this.enabled) return this.snapshot()

    this.settle()
    const targetValence = clamp(input.valence, -1, 1)
    const targetArousal = clamp(input.arousal, 0, 1)
    const ratio = clamp(weight, 0, 1)

    this.valence = clamp(this.valence + (targetValence - this.valence) * ratio, -1, 1)
    this.arousal = clamp(this.arousal + (targetArousal - this.arousal) * ratio, 0, 1)
    this.updatedAt = this.now()

    return this.snapshot()
  }

  /** 读取时惰性衰减；关闭时按零值返回。 */
  snapshot(): AfterglowSnapshot {
    if (!this.enabled) {
      return { valence: 0, arousal: 0, updatedAt: this.now() }
    }

    this.settle()
    return {
      valence: this.valence,
      arousal: this.arousal,
      updatedAt: this.updatedAt
    }
  }

  reset(): void {
    this.valence = 0
    this.arousal = 0
    this.updatedAt = this.now()
  }

  private settle(): void {
    const now = this.now()
    const elapsed = now - this.updatedAt
    if (elapsed <= 0) return

    this.valence = decayByHalfLife(this.valence, elapsed, this.halfLifeMs)
    this.arousal = decayByHalfLife(this.arousal, elapsed, this.halfLifeMs)

    if (Math.abs(this.valence) < this.epsilon) this.valence = 0
    if (Math.abs(this.arousal) < this.epsilon) this.arousal = 0

    this.updatedAt = now
  }
}
