import { describe, expect, it } from 'vitest'
import {
  buildLifestyle,
  describeLifestyle,
  festivalOf,
  localDateKey,
  outfitFor
} from '../lifestyle.js'

describe('节日表', () => {
  it('农历节日按表返回，除夕和春节各归各的', () => {
    expect(festivalOf('2026-02-16')).toEqual({ name: '除夕', kind: 'lunar' })
    expect(festivalOf('2026-02-17')).toEqual({ name: '春节', kind: 'lunar' })
    expect(festivalOf('2025-01-29')).toEqual({ name: '春节', kind: 'lunar' })
    expect(festivalOf('2035-02-08')).toEqual({ name: '春节', kind: 'lunar' })
    expect(festivalOf('2031-10-01')).toEqual({ name: '中秋', kind: 'lunar' })
  })

  it('公历固定节日任何年份都成立', () => {
    expect(festivalOf('2036-12-25')).toEqual({ name: '圣诞节', kind: 'gregorian' })
    expect(festivalOf('2040-01-01')).toEqual({ name: '元旦', kind: 'gregorian' })
    expect(festivalOf('2040-10-01')).toEqual({ name: '国庆节', kind: 'gregorian' })
  })

  it('表外年份不编造农历节日，也不抛异常', () => {
    // 2040-02-12 是那一年的春节，但表只到 2035，必须返回 null。
    expect(festivalOf('2040-02-12')).toBeNull()
    expect(festivalOf('2036-02-15')).toBeNull()
  })

  it('普通日子和坏输入都返回 null', () => {
    expect(festivalOf('2026-11-06')).toBeNull()
    expect(festivalOf('')).toBeNull()
    expect(festivalOf('2026-2-17')).toBeNull()
    expect(festivalOf('not-a-date')).toBeNull()
  })

  it('localDateKey 用本地日期，个位数补零', () => {
    expect(localDateKey(new Date(2026, 1, 7, 23, 59))).toBe('2026-02-07')
  })
})

describe('穿搭档位', () => {
  it('五个档位的边界按 coldest-first 命中', () => {
    expect(outfitFor(5)?.key).toBe('freezing')
    expect(outfitFor(6)?.key).toBe('cold')
    expect(outfitFor(12)?.key).toBe('cold')
    expect(outfitFor(13)?.key).toBe('cool')
    expect(outfitFor(20)?.key).toBe('cool')
    expect(outfitFor(21)?.key).toBe('mild')
    expect(outfitFor(27)?.key).toBe('mild')
    expect(outfitFor(28)?.key).toBe('hot')
    expect(outfitFor(-10)?.key).toBe('freezing')
  })

  it('没有有效温度就不给建议', () => {
    expect(outfitFor(null)).toBeNull()
    expect(outfitFor(undefined)).toBeNull()
    expect(outfitFor(Number.NaN)).toBeNull()
    expect(outfitFor(Number.POSITIVE_INFINITY)).toBeNull()
  })
})

describe('生活快照', () => {
  it('有节日有温度时两段都在', () => {
    const snapshot = buildLifestyle({ dateKey: '2026-02-17', feelsLike: 8 })
    expect(snapshot).toMatchObject({
      date: '2026-02-17',
      festival: { name: '春节' },
      hasWeather: true
    })
    expect(snapshot.outfit?.key).toBe('cold')
    const line = describeLifestyle(snapshot)
    expect(line).toContain('春节')
    expect(line).toContain('外面偏冷')
  })

  it('温度缺失时整段穿搭省略，不出现「穿」和「外面」', () => {
    const snapshot = buildLifestyle({ dateKey: '2026-02-17' })
    expect(snapshot.outfit).toBeNull()
    expect(snapshot.hasWeather).toBe(false)
    const line = describeLifestyle(snapshot)
    expect(line).toBe('今天是春节')
    expect(line).not.toContain('穿')
    expect(line).not.toContain('外面')
  })

  it('什么数据都没有时返回空串，调用方据此不加这一段', () => {
    const snapshot = buildLifestyle({ dateKey: '2026-11-06', feelsLike: null })
    expect(snapshot.festival).toBeNull()
    expect(snapshot.outfit).toBeNull()
    expect(describeLifestyle(snapshot)).toBe('')
  })
})

describe('她自己今天的样子', () => {
  it('同一天同一档温度，穿的和头发都是固定的', () => {
    const first = outfitFor(8, '2026-11-07')
    const again = outfitFor(8, '2026-11-07')

    expect(first?.wearing).toBe(again?.wearing)
    expect(first?.look).toBe(again?.look)
    expect(first?.wearing).not.toBe('')
  })

  it('换一天会换一身，不会整个冬天只有一套', () => {
    const days = ['2026-11-07', '2026-11-08', '2026-11-09', '2026-11-10', '2026-11-11']
    const outfits = new Set(days.map((day) => outfitFor(8, day)?.wearing))

    expect(outfits.size).toBeGreaterThan(1)
  })

  it('台词里带上她自己穿的，只在有真实温度时出现', () => {
    const withWeather = describeLifestyle(buildLifestyle({ dateKey: '2026-11-07', feelsLike: 8 }))
    expect(withWeather).toContain('你今天穿的是')

    const withoutWeather = describeLifestyle(buildLifestyle({ dateKey: '2026-11-07' }))
    expect(withoutWeather).not.toContain('你今天穿的是')
  })

  it('穿着不会写进给小满的天气建议里', () => {
    const band = outfitFor(8, '2026-11-07')
    expect(band?.tip).not.toContain(band?.wearing ?? '__none__')
  })
})
