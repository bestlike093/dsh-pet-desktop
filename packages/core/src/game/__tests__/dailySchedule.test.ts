import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TIMEOUT_MINUTES,
  GAME_IDS,
  EXECUTION_LIMIT_MARGIN_MINUTES,
  isCatchUpDue,
  nextRunAt,
  toTaskSpec,
  validateConfig
} from '../dailySchedule.js'
import type { GameDailyConfig } from '../dailySchedule.js'

function config(overrides: Partial<GameDailyConfig> = {}): GameDailyConfig {
  return {
    game: 'genshin',
    enabled: true,
    time: '04:00',
    days: [],
    timeoutMinutes: 150,
    mode: 'real',
    catchUp: false,
    reportSession: true,
    launchGame: false,
    ...overrides
  }
}

/** 2026-10-31 是周六。用本地时间构造，避免测试受时区影响。 */
function local(day: number, hour: number, minute = 0): number {
  return new Date(2026, 9, day, hour, minute, 0, 0).getTime()
}

describe('DEFAULT_TIMEOUT_MINUTES', () => {
  it('每个游戏都有默认超时', () => {
    for (const game of GAME_IDS) {
      expect(DEFAULT_TIMEOUT_MINUTES[game]).toBeGreaterThan(0)
    }
  })
})

describe('validateConfig', () => {
  it('合法配置没有issue', () => {
    expect(validateConfig(config())).toEqual([])
  })

  it('时间格式不对时指出字段', () => {
    const issues = validateConfig(config({ time: '4:00' }))
    expect(issues.map((issue) => issue.field)).toContain('time')
  })

  it('24:00 不合法', () => {
    expect(validateConfig(config({ time: '24:00' }))).not.toEqual([])
  })

  it('超时越界时给出范围', () => {
    const low = validateConfig(config({ timeoutMinutes: 4 }))
    const high = validateConfig(config({ timeoutMinutes: 181 }))
    expect(low[0]?.message).toContain('5')
    expect(high[0]?.message).toContain('180')
  })

  it('执行日越界被拦下', () => {
    expect(validateConfig(config({ days: [7] }))).not.toEqual([])
    expect(validateConfig(config({ days: [-1] }))).not.toEqual([])
  })

  it('一次返回全部问题', () => {
    const issues = validateConfig(config({ time: 'x', timeoutMinutes: 999, days: [9] }))
    expect(issues.length).toBeGreaterThanOrEqual(3)
  })
})

describe('toTaskSpec', () => {
  it('任务名带前缀与游戏', () => {
    expect(toTaskSpec(config()).name).toBe('game-daily-genshin')
    expect(toTaskSpec(config(), { prefix: 'game-daily-dev-' }).name).toBe('game-daily-dev-genshin')
  })

  it('系统执行时限 = 超时 + 余量', () => {
    const spec = toTaskSpec(config({ timeoutMinutes: 45 }))
    expect(spec.executionLimitMinutes).toBe(45 + EXECUTION_LIMIT_MARGIN_MINUTES)
  })

  it('执行日去重并升序', () => {
    const spec = toTaskSpec(config({ days: [5, 1, 5, 3] }))
    expect(spec.days).toEqual([1, 3, 5])
  })

  it('空执行日表示每天', () => {
    expect(toTaskSpec(config({ days: [] })).days).toEqual([])
  })
})

describe('nextRunAt', () => {
  it('今天还没到点，返回今天', () => {
    const at = nextRunAt(config({ time: '04:00' }), local(31, 2))
    expect(at).toBe(local(31, 4))
  })

  it('今天已过点，顺延到明天', () => {
    const at = nextRunAt(config({ time: '04:00' }), local(31, 12))
    expect(at).toBe(local(1 + 31, 4))
  })

  it('指定星期时跳到最近的执行日', () => {
    // 周六 12:00，只跑周一（1）
    const at = nextRunAt(config({ time: '04:00', days: [1] }), local(31, 12))
    expect(new Date(at as number).getDay()).toBe(1)
  })

  it('开启补跑时，今天已过点仍返回今天', () => {
    const at = nextRunAt(config({ time: '04:00', catchUp: true }), local(31, 12))
    expect(at).toBe(local(31, 4))
  })

  it('时间格式非法时抛错', () => {
    expect(() => nextRunAt(config({ time: 'bad' }), local(31, 12))).toThrow()
  })
})

describe('isCatchUpDue', () => {
  it('没开补跑时永远是 false', () => {
    expect(isCatchUpDue(config({ catchUp: false }), local(31, 12))).toBe(false)
  })

  it('开了补跑且已过点时为 true', () => {
    expect(isCatchUpDue(config({ catchUp: true, time: '04:00' }), local(31, 12))).toBe(true)
  })

  it('还没到点时不算补跑', () => {
    expect(isCatchUpDue(config({ catchUp: true, time: '04:00' }), local(31, 2))).toBe(false)
  })

  it('今天不是执行日时不算补跑', () => {
    // 周六只跑周一
    expect(isCatchUpDue(config({ catchUp: true, days: [1] }), local(31, 12))).toBe(false)
  })
})
