import { describe, expect, it } from 'vitest'

import {
  GAME_ASSISTANT_TASKS,
  RISK_CONFIRM_PHRASE,
  WEEKLY_POINT_CAP,
  confirmRisk,
  disableRisk,
  emptyRiskGate,
  findTask,
  nextWeeklyResetAt,
  normalizeWeeklyEntry,
  planTask,
  readRiskGate,
  summarizeWeek,
  weeklyKeyOf,
  type WeeklyEntry
} from '../gameAssistant.js'

/** 2026-11-06 周五 16:00（Asia/Shanghai 的墙上时间，用本地时间构造避免时区偏移）。 */
const FRIDAY_AFTERNOON = new Date(2026, 10, 6, 16, 0, 0).getTime()

function entry(patch: Partial<WeeklyEntry> = {}): WeeklyEntry {
  return {
    id: 'run-1',
    weekKey: weeklyKeyOf(FRIDAY_AFTERNOON),
    source: 'currency-war',
    difficulty: 'standard',
    completed: true,
    points: 18000,
    claimed: false,
    recordedAt: FRIDAY_AFTERNOON,
    ...patch
  }
}

describe('游戏任务目录', () => {
  it('货币战争与差分宇宙共享周常积分', () => {
    const currencyWar = findTask('starrail-currency-war')
    const divergent = findTask('starrail-divergent-universe')
    expect(currencyWar?.sharesWeeklyCap).toBe(true)
    expect(divergent?.sharesWeeklyCap).toBe(true)
    expect(currencyWar?.points).toBe(WEEKLY_POINT_CAP)
    expect(divergent?.points).toBe(WEEKLY_POINT_CAP)
  })

  it('任务 id 唯一', () => {
    const ids = GAME_ASSISTANT_TASKS.map((task) => task.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('周常刷新边界', () => {
  it('周五属于本周一', () => {
    expect(weeklyKeyOf(FRIDAY_AFTERNOON)).toBe('2026-11-02')
  })

  it('周一 03:59 仍算上一周', () => {
    const beforeReset = new Date(2026, 10, 9, 3, 59, 0).getTime()
    expect(weeklyKeyOf(beforeReset)).toBe('2026-11-02')
  })

  it('周一 04:00 进入新一周', () => {
    const afterReset = new Date(2026, 10, 9, 4, 0, 0).getTime()
    expect(weeklyKeyOf(afterReset)).toBe('2026-11-09')
  })

  it('下一次刷新是下周一 04:00', () => {
    const next = new Date(nextWeeklyResetAt(FRIDAY_AFTERNOON))
    expect(next.getDay()).toBe(1)
    expect(next.getHours()).toBe(4)
    expect(next.getTime()).toBeGreaterThan(FRIDAY_AFTERNOON)
  })
})

describe('周常积分账本', () => {
  it('达到上限后不再增长', () => {
    const summary = summarizeWeek(
      [entry({ id: 'a' }), entry({ id: 'b', source: 'divergent-universe' })],
      FRIDAY_AFTERNOON
    )
    expect(summary.earned).toBe(WEEKLY_POINT_CAP)
    expect(summary.remaining).toBe(0)
    expect(summary.full).toBe(true)
  })

  it('旧周记录不计入本周', () => {
    const old = entry({ id: 'old', weekKey: '2026-10-26' })
    const summary = summarizeWeek([old], FRIDAY_AFTERNOON)
    expect(summary.earned).toBe(0)
    expect(summary.full).toBe(false)
  })

  it('未领奖的积分单独统计', () => {
    const summary = summarizeWeek(
      [entry({ id: 'a', points: 12000, claimed: true }), entry({ id: 'b', points: 6000 })],
      FRIDAY_AFTERNOON
    )
    expect(summary.earned).toBe(18000)
    expect(summary.claimedPoints).toBe(12000)
    expect(summary.unclaimedPoints).toBe(6000)
  })

  it('拒绝未通关却领奖的记录', () => {
    const result = normalizeWeeklyEntry(
      {
        id: 'bad',
        source: 'currency-war',
        difficulty: 'overclock',
        completed: false,
        points: 9000,
        claimed: true,
        recordedAt: FRIDAY_AFTERNOON
      },
      FRIDAY_AFTERNOON
    )
    expect(result.ok).toBe(false)
  })

  it('拒绝超出上限的积分', () => {
    const result = normalizeWeeklyEntry(
      {
        id: 'bad',
        source: 'currency-war',
        difficulty: 'standard',
        completed: true,
        points: 20000,
        claimed: false,
        recordedAt: FRIDAY_AFTERNOON
      },
      FRIDAY_AFTERNOON
    )
    expect(result.ok).toBe(false)
  })

  it('合法记录会补上 weekKey', () => {
    const result = normalizeWeeklyEntry(
      {
        id: 'ok',
        source: 'divergent-universe',
        difficulty: 'standard',
        completed: true,
        points: 18000,
        claimed: false,
        recordedAt: FRIDAY_AFTERNOON
      },
      FRIDAY_AFTERNOON
    )
    expect(result.ok).toBe(true)
    expect(result.entry?.weekKey).toBe('2026-11-02')
  })
})

describe('两次风险确认门', () => {
  const goodInput = {
    acknowledged: true,
    phrase: RISK_CONFIRM_PHRASE,
    understandsRealRun: true
  }

  it('默认关闭', () => {
    const gate = emptyRiskGate()
    expect(gate.enabled).toBe(false)
    expect(gate.confirmations).toBe(0)
  })

  it('第一次确认只记录，不打开', () => {
    const result = confirmRisk(emptyRiskGate(), goodInput, 100)
    expect(result.ok).toBe(true)
    expect(result.stage).toBe('first')
    expect(result.state.enabled).toBe(false)
    expect(result.state.confirmations).toBe(1)
  })

  it('短语不对时保持关闭', () => {
    const result = confirmRisk(
      emptyRiskGate(),
      { ...goodInput, phrase: '我知道了' },
      100
    )
    expect(result.ok).toBe(false)
    expect(result.state.confirmations).toBe(0)
    expect(result.state.enabled).toBe(false)
  })

  it('第二次缺少真实执行确认时仍不打开', () => {
    const first = confirmRisk(emptyRiskGate(), goodInput, 100)
    const second = confirmRisk(
      first.state,
      { acknowledged: true, phrase: RISK_CONFIRM_PHRASE },
      200
    )
    expect(second.ok).toBe(false)
    expect(second.state.enabled).toBe(false)
  })

  it('连续两次合格才打开', () => {
    const first = confirmRisk(emptyRiskGate(), goodInput, 100)
    const second = confirmRisk(first.state, goodInput, 200)
    expect(second.ok).toBe(true)
    expect(second.stage).toBe('enabled')
    expect(second.state.enabled).toBe(true)
    expect(second.state.confirmations).toBe(2)
  })

  it('关闭后重新计数', () => {
    const first = confirmRisk(emptyRiskGate(), goodInput, 100)
    const second = confirmRisk(first.state, goodInput, 200)
    const closed = disableRisk(second.state, 300)
    expect(closed.enabled).toBe(false)
    expect(closed.confirmations).toBe(0)
  })

  it('手改磁盘文件不能把门打开', () => {
    const forged = readRiskGate({ enabled: true, confirmations: 1 })
    expect(forged.enabled).toBe(false)
    expect(forged.confirmations).toBe(1)
  })
})

describe('任务计划', () => {
  it('未知任务返回 null', () => {
    expect(planTask('not-exist')).toBeNull()
  })

  it('周常任务会提示积分共享', () => {
    const plan = planTask('starrail-currency-war')
    expect(plan?.mode).toBe('dry')
    expect(plan?.warnings.join('')).toContain('共享')
  })
})
