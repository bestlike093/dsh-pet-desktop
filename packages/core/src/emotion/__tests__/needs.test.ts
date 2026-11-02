import { describe, expect, it } from 'vitest'
import { NEED_KEYS, NeedsState } from '../needs.js'

function fixedClock(start: number) {
  let now = start
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms
    }
  }
}

describe('四类需求状态（E4）', () => {
  it('默认关闭：所有需求为零，dominant 固定 connection', () => {
    const state = new NeedsState({ now: () => 0 })
    const snapshot = state.snapshot()

    expect(snapshot.levels).toEqual({
      connection: 0,
      novelty: 0,
      achievement: 0,
      rest: 0
    })
    expect(snapshot.dominant).toBe('connection')
  })

  it('关闭时 advance 与 satisfy 都不改数值', () => {
    const clock = fixedClock(0)
    const state = new NeedsState({ now: clock.now })

    state.advance(3_600_000)
    state.satisfy('rest', 0.5)

    expect(state.snapshot().levels.rest).toBe(0)
  })

  it('按小时回升：半小时后 connection 增加 0.06', () => {
    const clock = fixedClock(0)
    const state = new NeedsState({ now: clock.now, enabled: true })

    clock.advance(30 * 60 * 1000)
    state.advance()

    expect(state.snapshot().levels.connection).toBeCloseTo(0.06, 6)
  })

  it('满足需求会下降，最低为 0', () => {
    const clock = fixedClock(0)
    const state = new NeedsState({ now: clock.now, enabled: true })

    state.setLevels({ rest: 0.3 })
    state.satisfy('rest', 0.5)

    expect(state.snapshot().levels.rest).toBe(0)
  })

  it('dominant 取当前最高的一项', () => {
    const clock = fixedClock(0)
    const state = new NeedsState({ now: clock.now, enabled: true })

    state.setLevels({ connection: 0.1, novelty: 0.2, achievement: 0.9, rest: 0.4 })

    expect(state.snapshot().dominant).toBe('achievement')
  })

  it('setLevels 会把越界值夹到 0..1', () => {
    const clock = fixedClock(0)
    const state = new NeedsState({ now: clock.now, enabled: true })

    state.setLevels({ connection: 5, rest: -2 })

    expect(state.snapshot().levels.connection).toBe(1)
    expect(state.snapshot().levels.rest).toBe(0)
  })

  it('回升封顶 1，不会越过上限', () => {
    const clock = fixedClock(0)
    const state = new NeedsState({ now: clock.now, enabled: true })

    clock.advance(100 * 3_600_000)
    state.advance()

    for (const key of NEED_KEYS) {
      expect(state.snapshot().levels[key]).toBe(1)
    }
  })
})
