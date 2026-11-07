import { describe, expect, it } from 'vitest'
import { humanDay, humanTime } from '../human-time.mjs'

// 固定一天的周六中午，避免「今天到底是哪天」影响用例。
const NOW = new Date(2026, 10, 7, 12, 30).getTime()
const at = (month, day, hour = 9, minute = 5) =>
  new Date(2026, month - 1, day, hour, minute).getTime()

describe('human-day 把日期说成人话', () => {
  it('今天、昨天、前天、大前天', () => {
    expect(humanDay(at(11, 7), NOW)).toBe('今天')
    expect(humanDay(at(11, 6), NOW)).toBe('昨天')
    expect(humanDay(at(11, 5), NOW)).toBe('前天')
    expect(humanDay(at(11, 4), NOW)).toBe('大前天')
  })

  it('明天、后天、大后天', () => {
    expect(humanDay(at(11, 8), NOW)).toBe('明天')
    expect(humanDay(at(11, 9), NOW)).toBe('后天')
    expect(humanDay(at(11, 10), NOW)).toBe('大后天')
  })

  it('再远按周说，周一算一周的开头', () => {
    // 11-07 是周六：11-02 是本周一，10-28 是上周三，10-21 是上上周三。
    expect(humanDay(at(11, 2), NOW)).toBe('周一')
    expect(humanDay(at(10, 28), NOW)).toBe('上周三')
    expect(humanDay(at(10, 21), NOW)).toBe('上上周三')
  })

  it('更远只说到月初、中旬、月底', () => {
    expect(humanDay(at(10, 14), NOW)).toBe('10 月中旬')
    expect(humanDay(at(10, 3), NOW)).toBe('10 月初')
    expect(humanDay(at(9, 28), NOW)).toBe('9 月底')
  })

  it('跨年加「去年」，不写成冷冰冰的日期', () => {
    const lastYear = new Date(2025, 11, 20, 9, 0).getTime()
    expect(humanDay(lastYear, NOW)).toBe('去年 12 月中旬')
  })

  it('没有时间就返回空串，不猜', () => {
    expect(humanDay(0, NOW)).toBe('')
    expect(humanDay(null, NOW)).toBe('')
    expect(humanDay('', NOW)).toBe('')
  })
})

describe('human-time 带上时刻', () => {
  it('近几天是「前天 09:05」这种说法', () => {
    expect(humanTime(at(11, 5, 21, 40), NOW)).toBe('前天 21:40')
    expect(humanTime(at(11, 7, 8, 3), NOW)).toBe('今天 08:03')
  })

  it('远一点的日子仍然带时刻', () => {
    expect(humanTime(at(10, 28, 23, 59), NOW)).toBe('上周三 23:59')
  })

  it('时间戳非法时返回空串', () => {
    expect(humanTime(undefined, NOW)).toBe('')
    expect(humanTime(-1, NOW)).toBe('')
  })
})
