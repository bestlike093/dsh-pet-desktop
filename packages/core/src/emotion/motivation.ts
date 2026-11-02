/**
 * 功能动机调度：把主动动作当候选，按需求、时段与冷却打分。
 *
 * 只做排序与挑选，不自己执行动作，也不自己开定时器。
 * 默认关闭；关闭时 pick 永远返回 null，调用方应保持静默。
 */

import type { NeedKey, NeedSnapshot } from '../emotion/needs.js'

export type MotivationAction = 'bubble' | 'dailyReview' | 'gameInvite' | 'greeting'

export interface MotivationCandidate {
  readonly action: MotivationAction
  /** 这个动作主要回应哪类需求。 */
  readonly need: NeedKey
  readonly baseScore: number
  /** 同一动作两次触发之间的最短间隔。 */
  readonly cooldownMs: number
  /** 允许的小时（本地时区 0..23）；不填表示全天可触发。 */
  readonly hours?: readonly number[]
}

export const DEFAULT_MOTIVATION_CANDIDATES: readonly MotivationCandidate[] = [
  {
    action: 'dailyReview',
    need: 'rest',
    baseScore: 0.7,
    cooldownMs: 12 * 60 * 60 * 1000,
    hours: [21, 22, 23]
  },
  {
    action: 'greeting',
    need: 'connection',
    baseScore: 0.6,
    cooldownMs: 2 * 60 * 60 * 1000,
    hours: [7, 8, 9, 18, 19, 20, 21, 22]
  },
  {
    action: 'gameInvite',
    need: 'novelty',
    baseScore: 0.4,
    cooldownMs: 4 * 60 * 60 * 1000,
    hours: [19, 20, 21, 22]
  },
  {
    action: 'bubble',
    need: 'connection',
    baseScore: 0.5,
    cooldownMs: 10 * 60 * 1000
  }
]

export interface MotivationContext {
  readonly now: number
  readonly needs: NeedSnapshot
  readonly lastFiredAt?: Partial<Record<MotivationAction, number>>
  readonly enabled: boolean
}

export type MotivationBlock = 'disabled' | 'cooldown' | 'hour'

export interface ScoredCandidate {
  readonly action: MotivationAction
  readonly score: number
  readonly blocked: MotivationBlock | null
}

export interface MotivationDecision {
  readonly action: MotivationAction | null
  readonly score: number
  /** 给诊断看的原因，不展示给用户。 */
  readonly reason: string
}

const NEED_WEIGHT = 0.8

function round(value: number): number {
  return Math.round(value * 1000) / 1000
}

function isHourAllowed(candidate: MotivationCandidate, now: number): boolean {
  if (candidate.hours === undefined || candidate.hours.length === 0) return true
  const hour = new Date(now).getHours()
  return candidate.hours.includes(hour)
}

function isInCooldown(candidate: MotivationCandidate, context: MotivationContext): boolean {
  const last = context.lastFiredAt?.[candidate.action]
  if (typeof last !== 'number' || !Number.isFinite(last)) return false
  return context.now - last < candidate.cooldownMs
}

export function scoreCandidates(
  candidates: readonly MotivationCandidate[],
  context: MotivationContext
): ScoredCandidate[] {
  return candidates.map((candidate) => {
    const level = context.needs.levels[candidate.need] ?? 0
    const score = round(candidate.baseScore + level * NEED_WEIGHT)

    let blocked: MotivationBlock | null = null
    if (!context.enabled) blocked = 'disabled'
    else if (isInCooldown(candidate, context)) blocked = 'cooldown'
    else if (!isHourAllowed(candidate, context.now)) blocked = 'hour'

    return { action: candidate.action, score, blocked }
  })
}

/** 稳定排序：分数高的在前，同分保持候选顺序。 */
export function pickMotivation(
  candidates: readonly MotivationCandidate[],
  context: MotivationContext
): MotivationDecision {
  if (!context.enabled) return { action: null, score: 0, reason: 'disabled' }

  const scored = scoreCandidates(candidates, context)
    .filter((item) => item.blocked === null)
    .sort((left, right) => right.score - left.score)

  const best = scored[0]
  if (best === undefined) return { action: null, score: 0, reason: 'no-candidate' }

  return { action: best.action, score: best.score, reason: 'ok' }
}
