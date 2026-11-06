import { describe, expect, it } from 'vitest'

import {
  BodyRuntime,
  CHAT_COOLDOWN_MS,
  DEFAULT_SLEEP_WINDOW,
  MAX_SLEEP_DEBT,
  advance,
  bodyFlags,
  cyclePhase,
  describeBody,
  freshState,
  inSleepWindow,
  readState,
  toMinute
} from '../body.js'

const HOUR = 60 * 60_000

function at(hour: number, minute = 0): number {
  return new Date(2026, 0, 5, hour, minute, 0, 0).getTime()
}

describe('toMinute / inSleepWindow', () => {
  it('只认 HH:MM', () => {
    expect(toMinute('23:30')).toBe(1410)
    expect(toMinute('7:05')).toBe(425)
    expect(toMinute('24:00')).toBeNull()
    expect(toMinute('aa:bb')).toBeNull()
    expect(toMinute(null)).toBeNull()
  })

  it('能处理跨天窗口', () => {
    expect(inSleepWindow(at(2), DEFAULT_SLEEP_WINDOW)).toBe(true)
    expect(inSleepWindow(at(12), DEFAULT_SLEEP_WINDOW)).toBe(false)
    expect(inSleepWindow(at(7, 30), DEFAULT_SLEEP_WINDOW)).toBe(false)
  })

  it('窗口两端相同视为关闭，不当作整夜', () => {
    expect(inSleepWindow(at(2), { start: '23:00', end: '23:00' })).toBe(false)
  })
})

describe('readState / advance', () => {
  it('缺字段时补默认值，越界值夹紧', () => {
    const state = readState({ energy: 30, sleepDebt: 999 })
    expect(state.energy).toBe(30)
    expect(state.sleepDebt).toBe(MAX_SLEEP_DEBT)
    expect(state.hunger).toBe(freshState().hunger)
    expect(state.cycle.enabled).toBe(false)
  })

  it('读回时沿用文件里的 updatedAt，离线时间才补得上', () => {
    const saved = at(9)
    expect(readState({ updatedAt: saved }, saved + 3 * HOUR).updatedAt).toBe(saved)
  })

  it('时间戳跑到未来时改用此刻，避免状态被冻住', () => {
    const now = at(9)
    expect(readState({ updatedAt: now + 5 * HOUR }, now).updatedAt).toBe(now)
  })

  it('醒着推进：精力、社交力气下降，困意、饥饿上升', () => {
    const start = at(9)
    const state = freshState(start)
    const next = advance(state, start, start + 4 * HOUR, { sleepWindow: DEFAULT_SLEEP_WINDOW })
    expect(next.energy).toBeLessThan(state.energy)
    expect(next.drowsiness).toBeGreaterThan(state.drowsiness)
    expect(next.hunger).toBeGreaterThan(state.hunger)
    expect(next.socialEnergy).toBeLessThan(state.socialEnergy)
    expect(next.updatedAt).toBe(start + 4 * HOUR)
  })

  it('睡着推进：精力回升、困意回落、睡眠债减少', () => {
    const start = at(0)
    const state = { ...freshState(start), energy: 30, drowsiness: 80, sleepDebt: 4 }
    const next = advance(state, start, start + 3 * HOUR, { sleepWindow: DEFAULT_SLEEP_WINDOW })
    expect(next.energy).toBeGreaterThan(state.energy)
    expect(next.drowsiness).toBeLessThan(state.drowsiness)
    expect(next.sleepDebt).toBeLessThan(state.sleepDebt)
  })

  it('补算有上限：跨一周也不会越界或变成 NaN', () => {
    const start = at(9)
    const state = freshState(start)
    const next = advance(state, start, start + 7 * 24 * HOUR, {
      sleepWindow: DEFAULT_SLEEP_WINDOW
    })
    for (const key of ['energy', 'drowsiness', 'hunger', 'socialEnergy', 'discomfort'] as const) {
      expect(Number.isFinite(next[key])).toBe(true)
      expect(next[key]).toBeGreaterThanOrEqual(0)
      expect(next[key]).toBeLessThanOrEqual(100)
    }
    expect(next.sleepDebt).toBeGreaterThanOrEqual(0)
    expect(next.sleepDebt).toBeLessThanOrEqual(MAX_SLEEP_DEBT)
  })

  it('时间倒流不推进', () => {
    const start = at(9)
    const state = freshState(start)
    const next = advance(state, start, start - HOUR)
    expect(next.energy).toBe(state.energy)
    expect(next.drowsiness).toBe(state.drowsiness)
  })

  it('补算最多只走 72 小时，再久也不会越算越狠', () => {
    const start = at(9)
    const state = freshState(start)
    const threeDays = advance(state, start, start + 72 * HOUR, {
      sleepWindow: DEFAULT_SLEEP_WINDOW
    })
    const aWeek = advance(state, start, start + 7 * 24 * HOUR, {
      sleepWindow: DEFAULT_SLEEP_WINDOW
    })
    expect(aWeek.energy).toBeCloseTo(threeDays.energy, 6)
    expect(aWeek.sleepDebt).toBeCloseTo(threeDays.sleepDebt, 6)
  })
})

describe('describeBody / bodyFlags / cyclePhase', () => {
  it('最多三条，不报数字', () => {
    const text = describeBody({
      ...freshState(0),
      drowsiness: 90,
      hunger: 90,
      socialEnergy: 10,
      sleepDebt: 9,
      energy: 15,
      discomfort: 80
    })
    expect(text).not.toBe('')
    expect(text.split('；').length).toBeLessThanOrEqual(3)
    expect(/\d/.test(text)).toBe(false)
  })

  it('刚醒那阵才提梦，过了就不提', () => {
    const base = {
      ...freshState(0),
      energy: 90,
      drowsiness: 10,
      lastDreamAt: 1 * HOUR,
      dream: '梦见一片很静的水。'
    }
    expect(describeBody({ ...base, updatedAt: 2 * HOUR })).toContain('梦见一片很静的水')
    expect(describeBody({ ...base, updatedAt: 6 * HOUR })).not.toContain('刚醒过来')
  })

  it('硬阈值只给闸门用', () => {
    const flags = bodyFlags({
      ...freshState(0),
      energy: 10,
      drowsiness: 70,
      hunger: 80,
      socialEnergy: 10,
      sleepDebt: 9
    })
    expect(flags).toEqual({
      lowEnergy: true,
      sleepy: true,
      hungry: true,
      drained: true,
      exhausted: true
    })
    expect(bodyFlags(null).exhausted).toBe(false)
  })

  it('生理周期没开或没记录就返回 null，不猜', () => {
    expect(cyclePhase(freshState(0))).toBeNull()
    const enabled = {
      ...freshState(0),
      cycle: { enabled: true, lastStart: at(0), length: 28 }
    }
    expect(cyclePhase(enabled, at(0) + 24 * HOUR)?.phase).toBe('menstrual')
  })
})

describe('BodyRuntime', () => {
  it('走出睡窗就当自然醒，带上梦和被打断的倦', () => {
    let clock = at(7)
    const runtime = new BodyRuntime({ now: () => clock })

    runtime.markInterrupted(clock)
    clock = at(8)
    const snapshot = runtime.tick(clock)

    expect(snapshot.asleep).toBe(false)
    expect(snapshot.justWoke).toBe(true)
    expect(snapshot.dream.length).toBeGreaterThan(0)
    expect(snapshot.interrupted).toBe(0)
    expect(snapshot.lastWokeInterrupted).toBe(1)
    expect(runtime.describe()).toContain('刚醒过来')
    expect(runtime.describe()).toContain('被吵醒过')
  })

  it('连着说话会累，但同一小段时间只算一次', () => {
    const start = at(9)
    const runtime = new BodyRuntime({ now: () => start })

    const before = runtime.tick(start).socialEnergy
    const after = runtime.noteChat(3, start).socialEnergy
    expect(after).toBeLessThan(before)

    // 冷却期内不再扣，只走时间自然衰减。
    const repeated = runtime.noteChat(3, start + 10_000).socialEnergy
    expect(Math.abs(repeated - after)).toBeLessThan(0.2)

    // 过了冷却再算一次。
    const later = runtime.noteChat(3, start + CHAT_COOLDOWN_MS + 1_000).socialEnergy
    expect(later).toBeLessThan(repeated - 1)
  })

  it('被吵到会计数，醒来只结算一次', () => {
    const start = at(2)
    const runtime = new BodyRuntime({ now: () => start })

    runtime.markInterrupted(start)
    runtime.markInterrupted(start + 60_000)
    const result = runtime.wake(start + 120_000)

    expect(result.interrupted).toBe(2)
    expect(typeof result.dream).toBe('string')
    expect(runtime.snapshot().interrupted).toBe(0)
    expect(runtime.snapshot().lastWokeInterrupted).toBe(2)
  })

  it('存盘再读回，离线时间继续补算', () => {
    const start = at(9)
    const runtime = new BodyRuntime({ now: () => start })
    const saved = runtime.tick(start).energy
    const dump = JSON.parse(JSON.stringify(runtime.toJSON())) as unknown

    const noon = start + 3 * HOUR
    const restored = new BodyRuntime({ now: () => noon })
    restored.replace(dump as never)
    const snapshot = restored.tick(noon)

    expect(snapshot.energy).toBeLessThan(saved)
    expect(snapshot.updatedAt).toBe(noon)
  })

  it('落盘只写状态，不写派生字段', () => {
    const runtime = new BodyRuntime({ now: () => at(9) })
    const dump = runtime.toJSON()
    expect(dump.updatedAt).toBe(at(9))
    expect('flags' in dump).toBe(false)
    expect('asleep' in dump).toBe(false)
    expect('phase' in dump).toBe(false)
  })

  it('stats 只给四舍五入后的体检值', () => {
    const runtime = new BodyRuntime({
      now: () => at(9),
      state: { ...freshState(at(9)), energy: 63.6, sleepDebt: 2.34 }
    })
    const stats = runtime.stats()
    expect(stats.energy).toBe(64)
    expect(stats.sleepDebt).toBe(2.3)
    expect(typeof stats.flags.lowEnergy).toBe('boolean')
  })

  it('describe 不出现数字', () => {
    const runtime = new BodyRuntime({
      now: () => at(9),
      state: { ...freshState(at(9)), energy: 20, drowsiness: 70, hunger: 60 }
    })
    const text = runtime.describe()
    expect(text.length).toBeGreaterThan(0)
    expect(/\d/.test(text)).toBe(false)
  })
})
