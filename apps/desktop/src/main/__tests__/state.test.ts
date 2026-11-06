import { describe, expect, it } from 'vitest'
import {
  PRESENCE_INTERVAL_DEFAULT_MINUTES,
  PRESENCE_INTERVAL_MAX_MINUTES,
  PRESENCE_INTERVAL_MIN_MINUTES,
  presenceIntervalMs
} from '../state.js'

const minute = 60 * 1000

describe('presenceIntervalMs', () => {
  it('正常值按分钟换算', () => {
    expect(presenceIntervalMs(12)).toBe(12 * minute)
    expect(presenceIntervalMs(30)).toBe(30 * minute)
  })

  it('低于下限抬到 1 分钟', () => {
    expect(presenceIntervalMs(0)).toBe(PRESENCE_INTERVAL_MIN_MINUTES * minute)
    expect(presenceIntervalMs(-5)).toBe(PRESENCE_INTERVAL_MIN_MINUTES * minute)
  })

  it('高于上限压到 120 分钟', () => {
    expect(presenceIntervalMs(500)).toBe(PRESENCE_INTERVAL_MAX_MINUTES * minute)
  })

  it('小数保留', () => {
    expect(presenceIntervalMs(1.5)).toBe(1.5 * minute)
  })

  it('非数值回默认 45 分钟', () => {
    expect(presenceIntervalMs(undefined)).toBe(PRESENCE_INTERVAL_DEFAULT_MINUTES * minute)
    expect(presenceIntervalMs('abc')).toBe(PRESENCE_INTERVAL_DEFAULT_MINUTES * minute)
    expect(presenceIntervalMs(NaN)).toBe(PRESENCE_INTERVAL_DEFAULT_MINUTES * minute)
    expect(presenceIntervalMs(Infinity)).toBe(PRESENCE_INTERVAL_DEFAULT_MINUTES * minute)
  })

  it('数字字符串按数值处理', () => {
    expect(presenceIntervalMs('20')).toBe(20 * minute)
  })

  it('null 被 Number 成 0，落到下限而不是默认值', () => {
    expect(presenceIntervalMs(null)).toBe(PRESENCE_INTERVAL_MIN_MINUTES * minute)
  })
})
