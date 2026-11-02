import { describe, expect, it } from 'vitest'
import type { NeedKey, NeedSnapshot } from '../needs.js'
import {
  DEFAULT_MOTIVATION_CANDIDATES,
  pickMotivation,
  scoreCandidates
} from '../motivation.js'

function needs(levels: Partial<Record<NeedKey, number>> = {}): NeedSnapshot {
  return {
    levels: { connection: 0, novelty: 0, achievement: 0, rest: 0, ...levels },
    dominant: 'connection',
    updatedAt: 0
  }
}

function atHour(hour: number, minute = 0): number {
  return new Date(2026, 0, 1, hour, minute, 0, 0).getTime()
}

describe('功能动机调度：打分、冷却与关闭（E5）', () => {
  it('默认关闭时永远不选动作', () => {
    const decision = pickMotivation(DEFAULT_MOTIVATION_CANDIDATES, {
      now: atHour(22),
      needs: needs({ connection: 1 }),
      enabled: false
    })

    expect(decision).toEqual({ action: null, score: 0, reason: 'disabled' })
  })

  it('需求高且时段合适的动作胜出', () => {
    const decision = pickMotivation(DEFAULT_MOTIVATION_CANDIDATES, {
      now: atHour(22),
      needs: needs({ connection: 1, rest: 0 }),
      enabled: true
    })

    // greeting: 0.6 + 0.8 = 1.4；dailyReview: 0.7
    expect(decision.action).toBe('greeting')
    expect(decision.score).toBeCloseTo(1.4, 3)
  })

  it('冷却中的动作被排除', () => {
    const now = atHour(22)
    const decision = pickMotivation(DEFAULT_MOTIVATION_CANDIDATES, {
      now,
      needs: needs({ connection: 1, rest: 1 }),
      lastFiredAt: { greeting: now - 60_000 },
      enabled: true
    })

    // dailyReview: 0.7 + 0.8 = 1.5；bubble 仍是 1.3
    expect(decision.action).toBe('dailyReview')
  })

  it('时段外只剩全天候选', () => {
    const decision = pickMotivation(DEFAULT_MOTIVATION_CANDIDATES, {
      now: atHour(3),
      needs: needs({ connection: 0 }),
      enabled: true
    })

    expect(decision.action).toBe('bubble')
  })

  it('scoreCandidates 标出每项被什么挡住', () => {
    const now = atHour(3)
    const scored = scoreCandidates(DEFAULT_MOTIVATION_CANDIDATES, {
      now,
      needs: needs({ connection: 0.5 }),
      lastFiredAt: { bubble: now },
      enabled: true
    })

    const byAction = new Map(scored.map((item) => [item.action, item]))
    expect(byAction.get('dailyReview')?.blocked).toBe('hour')
    expect(byAction.get('bubble')?.blocked).toBe('cooldown')
    expect(byAction.get('gameInvite')?.blocked).toBe('hour')
  })

  it('关闭时所有候选都标记 disabled', () => {
    const scored = scoreCandidates(DEFAULT_MOTIVATION_CANDIDATES, {
      now: atHour(22),
      needs: needs(),
      enabled: false
    })

    expect(scored.every((item) => item.blocked === 'disabled')).toBe(true)
  })
})
