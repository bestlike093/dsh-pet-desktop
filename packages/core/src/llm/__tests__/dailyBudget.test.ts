import { describe, expect, it } from 'vitest'
import { DailyBudgetGate } from '../dailyBudget.js'
import { localDayKey } from '../dailyBudget.js'

/** 本地时间构造，避免测试机时区影响日期键。 */
function at(year: number, month: number, day: number, hour = 12): number {
  return new Date(year, month - 1, day, hour, 0, 0).getTime()
}

function clock(initial: number) {
  let current = initial
  return {
    now: () => current,
    set: (value: number) => {
      current = value
    }
  }
}

describe('localDayKey', () => {
  it('输出 YYYY-MM-DD，月日补零', () => {
    expect(localDayKey(at(2026, 3, 7))).toBe('2026-03-07')
    expect(localDayKey(at(2026, 10, 31, 23))).toBe('2026-10-31')
  })
})

describe('DailyBudgetGate', () => {
  it('dailyLimit 为 0 时不限额，永远放行', () => {
    const gate = new DailyBudgetGate({ dailyLimit: 0, ...clock(at(2026, 10, 31)) })

    gate.record(1_000_000)

    expect(gate.canSpend(1_000_000)).toEqual({
      allowed: true,
      remaining: Number.POSITIVE_INFINITY
    })
    expect(gate.status().level).toBe('ok')
    expect(Number.isFinite(gate.status().remaining)).toBe(false)
  })

  it('未到上限时放行，并返回扣掉预估后的余额', () => {
    const gate = new DailyBudgetGate({ dailyLimit: 1000, ...clock(at(2026, 10, 31)) })
    gate.record(300)

    expect(gate.canSpend(200)).toEqual({ allowed: true, remaining: 500 })
  })

  it('预估会超出上限时拒绝，并带上已用与上限', () => {
    const gate = new DailyBudgetGate({ dailyLimit: 1000, ...clock(at(2026, 10, 31)) })
    gate.record(900)

    expect(gate.canSpend(200)).toEqual({
      allowed: false,
      reason: 'limit-reached',
      used: 900,
      limit: 1000
    })
  })

  it('恰好用完也拒绝：canSpend(0) 不再放行', () => {
    const gate = new DailyBudgetGate({ dailyLimit: 1000, ...clock(at(2026, 10, 31)) })
    gate.record(1000)

    expect(gate.canSpend(0).allowed).toBe(false)
    expect(gate.status().level).toBe('exhausted')
  })

  it('达到预警占比进入 warn，未达到保持 ok', () => {
    const gate = new DailyBudgetGate({ dailyLimit: 1000, ...clock(at(2026, 10, 31)) })

    gate.record(799)
    expect(gate.status().level).toBe('ok')

    gate.record(1)
    expect(gate.status().level).toBe('warn')
  })

  it('warnRatio 可配置，越界值回落到默认 0.8', () => {
    const strict = new DailyBudgetGate({
      dailyLimit: 100,
      warnRatio: 0.5,
      ...clock(at(2026, 10, 31))
    })
    strict.record(50)
    expect(strict.status().level).toBe('warn')

    const fallback = new DailyBudgetGate({
      dailyLimit: 100,
      warnRatio: 0,
      ...clock(at(2026, 10, 31))
    })
    fallback.record(79)
    expect(fallback.status().level).toBe('ok')
  })

  it('跨到第二天自动清零并切换日期键', () => {
    const time = clock(at(2026, 10, 31, 23))
    const gate = new DailyBudgetGate({ dailyLimit: 1000, ...time })
    gate.record(1000)
    expect(gate.status().level).toBe('exhausted')

    time.set(at(2026, 11, 1, 0))

    expect(gate.dayKey).toBe('2026-11-01')
    expect(gate.used).toBe(0)
    expect(gate.canSpend(500).allowed).toBe(true)
  })

  it('serialize / restore：同一天接着累计', () => {
    const time = clock(at(2026, 10, 31))
    const gate = new DailyBudgetGate({ dailyLimit: 1000, ...time })
    gate.record(400)

    const restored = DailyBudgetGate.restore({ dailyLimit: 1000, ...time }, gate.serialize())

    expect(restored.used).toBe(400)
    expect(restored.canSpend(600).allowed).toBe(true)
    expect(restored.canSpend(601).allowed).toBe(false)
  })

  it('restore 时若已跨日，旧额度不带到新的一天', () => {
    const state = { dayKey: '2026-10-30', used: 900 }
    const gate = DailyBudgetGate.restore(
      { dailyLimit: 1000, ...clock(at(2026, 10, 31)) },
      state
    )

    expect(gate.used).toBe(0)
    expect(gate.dayKey).toBe('2026-10-31')
  })

  it('超额也照实记账，方便看板显示超了多少', () => {
    const gate = new DailyBudgetGate({ dailyLimit: 1000, ...clock(at(2026, 10, 31)) })
    gate.record(1200)

    const status = gate.status()
    expect(status.used).toBe(1200)
    expect(status.remaining).toBe(0)
    expect(status.ratio).toBe(1.2)
  })

  it('负数、NaN、Infinity 都不计入', () => {
    const gate = new DailyBudgetGate({ dailyLimit: 1000, ...clock(at(2026, 10, 31)) })

    gate.record(-50)
    gate.record(Number.NaN)
    gate.record(Number.POSITIVE_INFINITY)

    expect(gate.used).toBe(0)
  })

  it('canSpend 不扣减，多次预检结果一致', () => {
    const gate = new DailyBudgetGate({ dailyLimit: 1000, ...clock(at(2026, 10, 31)) })

    expect(gate.canSpend(300)).toEqual(gate.canSpend(300))
    expect(gate.used).toBe(0)
  })
})
