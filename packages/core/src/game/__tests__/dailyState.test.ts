import { describe, expect, it } from 'vitest'
import {
  defaultDailyState,
  defaultGameConfig,
  describeDailyState,
  enabledGames,
  normalizeDailyState,
  summarizeDailyState,
  updateGameConfig
} from '../dailyState.js'

describe('defaultGameConfig', () => {
  it('默认关闭、演练，时间按游戏错开', () => {
    const genshin = defaultGameConfig('genshin')
    expect(genshin.enabled).toBe(false)
    expect(genshin.mode).toBe('dry')
    expect(genshin.time).toBe('04:00')
    expect(genshin.days).toEqual([])
    expect(defaultGameConfig('starrail').time).toBe('05:30')
  })

  it('四个游戏的默认超时不同', () => {
    expect(defaultGameConfig('genshin').timeoutMinutes).toBe(150)
    expect(defaultGameConfig('starrail').timeoutMinutes).toBe(45)
  })
})

describe('normalizeDailyState', () => {
  it('空输入回到默认状态', () => {
    const state = normalizeDailyState(null)
    expect(state.games.genshin.enabled).toBe(false)
    expect(state.games.starrail.mode).toBe('dry')
    expect(state.updatedAt).toBeNull()
  })

  it('非法字段退回默认，不整份判死', () => {
    const state = normalizeDailyState({
      games: {
        genshin: { enabled: true, time: '25:99', timeoutMinutes: 999, mode: 'real' }
      }
    })
    expect(state.games.genshin.enabled).toBe(true)
    expect(state.games.genshin.time).toBe('04:00')
    expect(state.games.genshin.timeoutMinutes).toBe(150)
    expect(state.games.genshin.mode).toBe('real')
  })

  it('未知 mode 一律降级成演练', () => {
    const state = normalizeDailyState({
      games: { starrail: { mode: 'auto' } }
    })
    expect(state.games.starrail.mode).toBe('dry')
  })

  it('执行日过滤到 0–6 并去重', () => {
    const state = normalizeDailyState({
      games: { hi3: { days: [1, 1, 5, 9, -1, 'x'] } }
    })
    expect(state.games.hi3.days).toEqual([1, 5])
  })

  it('迁移旧的单配置形状', () => {
    const state = normalizeDailyState({
      game: 'genshin',
      enabled: true,
      time: '06:30',
      mode: 'dry'
    })
    expect(state.games.genshin.enabled).toBe(true)
    expect(state.games.genshin.time).toBe('06:30')
    expect(state.games.starrail.enabled).toBe(false)
  })

  it('缺某个游戏时补默认值', () => {
    const state = normalizeDailyState({ games: { genshin: { enabled: true } } })
    expect(state.games.zzz).toBeDefined()
    expect(state.games.zzz.enabled).toBe(false)
  })
})

describe('updateGameConfig', () => {
  it('合法 patch 写入并记录更新时间', () => {
    const state = defaultDailyState()
    const result = updateGameConfig(state, 'genshin', { enabled: true, time: '07:15' }, 1_700_000_000_000)
    expect(result.ok).toBe(true)
    expect(result.state.games.genshin.enabled).toBe(true)
    expect(result.state.games.genshin.time).toBe('07:15')
    expect(result.state.updatedAt).toBe(1_700_000_000_000)
  })

  it('非法配置返回 issues，且原 state 不变', () => {
    const state = defaultDailyState()
    const result = updateGameConfig(state, 'starrail', { time: '9:5' }, 1)
    expect(result.ok).toBe(false)
    expect(result.issues.some((issue) => issue.field === 'time')).toBe(true)
    expect(result.state).toBe(state)
    expect(result.state.games.starrail.time).toBe('05:30')
  })

  it('超时越界被拦下', () => {
    const state = defaultDailyState()
    const result = updateGameConfig(state, 'genshin', { timeoutMinutes: 999 }, 1)
    expect(result.ok).toBe(false)
    expect(result.issues.some((issue) => issue.field === 'timeoutMinutes')).toBe(true)
  })

  it('空字符串可以清空 gamePath', () => {
    const withPath = updateGameConfig(
      defaultDailyState(),
      'genshin',
      { gamePath: 'D:\\BetterGI\\BetterGI.exe' },
      1
    )
    expect(withPath.state.games.genshin.gamePath).toBe('D:\\BetterGI\\BetterGI.exe')

    const cleared = updateGameConfig(withPath.state, 'genshin', { gamePath: '' }, 2)
    expect(cleared.ok).toBe(true)
    expect(cleared.state.games.genshin.gamePath).toBeUndefined()
  })

  it('执行日排序去重', () => {
    const result = updateGameConfig(defaultDailyState(), 'hi3', { days: [5, 1, 5] }, 1)
    expect(result.state.games.hi3.days).toEqual([1, 5])
  })
})

describe('汇总', () => {
  it('只统计打开的游戏，并按时间排序', () => {
    let state = defaultDailyState()
    state = updateGameConfig(state, 'starrail', { enabled: true, time: '05:30', mode: 'real' }, 1).state
    state = updateGameConfig(state, 'genshin', { enabled: true, time: '04:00' }, 1).state

    const enabled = enabledGames(state)
    expect(enabled.map((config) => config.game)).toEqual(['genshin', 'starrail'])

    const summary = summarizeDailyState(state)
    expect(summary.enabled).toBe(2)
    expect(summary.real).toBe(1)
    expect(summary.dry).toBe(1)
  })

  it('全关时给一句明确的话', () => {
    expect(describeDailyState(defaultDailyState())).toContain('都还关着')
  })

  it('打开后带上时间与演练标记', () => {
    const state = updateGameConfig(defaultDailyState(), 'genshin', { enabled: true }, 1).state
    const text = describeDailyState(state)
    expect(text).toContain('原神 04:00')
    expect(text).toContain('演练')
  })
})
