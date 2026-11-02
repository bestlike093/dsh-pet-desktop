/**
 * S2 DoD ①③：IScaler 纯函数。
 * 12 组边界：超宽 / 超高 / 极小 / 1×1 / 等比 / 非整数 / 分母 0 /
 * profile 切换 / 缩放 0.5 / 缩放 2.0 / 源尺寸 0 / 无效输入防御。
 * 另覆盖：align 两态、profile.anchor 同源、windowSizeFor、contentRect。
 */
import { describe, expect, it } from 'vitest'
import { SIZE_PROFILES, alignForProfile } from '@pet/shared'
import { createScaler } from '../scaler.js'

const scaler = createScaler()
const upscaling = createScaler({ allowUpscale: true })

describe('Scaler.fit 12 组边界', () => {
  it('① 超宽：2000×500 → vertical 600×150，底对齐', () => {
    const result = scaler.fit({ w: 2000, h: 500 }, SIZE_PROFILES.vertical)

    expect(result.scale).toBeCloseTo(0.3)
    expect(result.width).toBe(600)
    expect(result.height).toBe(150)
    expect(result.offsetX).toBe(0)
    expect(result.offsetY).toBe(650)
  })

  it('② 超高：500×2000 → vertical 200×800，水平居中', () => {
    const result = scaler.fit({ w: 500, h: 2000 }, SIZE_PROFILES.vertical)

    expect(result.scale).toBeCloseTo(0.4)
    expect(result.width).toBe(200)
    expect(result.height).toBe(800)
    expect(result.offsetX).toBe(200)
    expect(result.offsetY).toBe(0)
  })

  it('③ 极小：10×10 → square 默认不放大，保持 10×10', () => {
    const result = scaler.fit({ w: 10, h: 10 }, SIZE_PROFILES.square)

    expect(result.scale).toBe(1)
    expect(result.width).toBe(10)
    expect(result.height).toBe(10)
    expect(result.offsetX).toBe(251)
    expect(result.offsetY).toBe(502)
  })

  it('④ 1×1 → square 保持 1×1，取整后居中', () => {
    const result = scaler.fit({ w: 1, h: 1 }, SIZE_PROFILES.square)

    expect(result.scale).toBe(1)
    expect(result.width).toBe(1)
    expect(result.height).toBe(1)
    expect(result.offsetX).toBe(256)
    expect(result.offsetY).toBe(511)
  })

  it('⑤ 等比：1000×300 → vertical 600×180（DoD ①）', () => {
    const result = scaler.fit({ w: 1000, h: 300 }, SIZE_PROFILES.vertical)

    expect(result.scale).toBeCloseTo(0.6)
    expect(result.width).toBe(600)
    expect(result.height).toBe(180)
    expect(result.offsetX).toBe(0)
    expect(result.offsetY).toBe(620)
  })

  it('⑥ 非整数：333×777 → card，宽高按 Math.round 取整', () => {
    const result = scaler.fit({ w: 333, h: 777 }, SIZE_PROFILES.card)

    expect(result.scale).toBeCloseTo(240 / 777)
    expect(result.width).toBe(103)
    expect(result.height).toBe(240)
    expect(result.offsetX).toBe(139)
    expect(result.offsetY).toBe(0)
  })

  it('⑦ 分母为 0：源尺寸 0×0 返回全零，不抛错', () => {
    const result = scaler.fit({ w: 0, h: 0 }, SIZE_PROFILES.vertical)

    expect(result).toEqual({ scale: 0, offsetX: 0, offsetY: 0, width: 0, height: 0 })
  })

  it('⑧ profile 切换：同一源尺寸在四个预设下各自等比', () => {
    const natural = { w: 1000, h: 300 }

    const vertical = scaler.fit(natural, SIZE_PROFILES.vertical)
    const horizontal = scaler.fit(natural, SIZE_PROFILES.horizontal)
    const square = scaler.fit(natural, SIZE_PROFILES.square)
    const card = scaler.fit(natural, SIZE_PROFILES.card)

    expect([vertical.width, vertical.height]).toEqual([600, 180])
    expect([horizontal.width, horizontal.height]).toEqual([800, 240])
    expect([square.width, square.height]).toEqual([512, 154])
    expect([card.width, card.height]).toEqual([380, 114])

    for (const result of [vertical, horizontal, square, card]) {
      expect(result.width / result.height).toBeCloseTo(1000 / 300, 1)
    }
  })

  it('⑨ 缩放 0.5：1200×1600 → vertical 正好铺满', () => {
    const result = scaler.fit({ w: 1200, h: 1600 }, SIZE_PROFILES.vertical)

    expect(result.scale).toBeCloseTo(0.5)
    expect(result.width).toBe(600)
    expect(result.height).toBe(800)
  })

  it('⑩ 缩放 2.0：300×400 → vertical，允许放大时才铺满', () => {
    const defaultResult = scaler.fit({ w: 300, h: 400 }, SIZE_PROFILES.vertical)
    expect(defaultResult.scale).toBe(1)
    expect(defaultResult.width).toBe(300)

    const result = upscaling.fit({ w: 300, h: 400 }, SIZE_PROFILES.vertical)
    expect(result.scale).toBeCloseTo(2)
    expect(result.width).toBe(600)
    expect(result.height).toBe(800)
  })

  it('⑪ 源尺寸为 0：video 未拿到 metadata 的两种形态都返回全零', () => {
    for (const natural of [
      { w: 0, h: 0 },
      { w: 0, h: 600 }
    ]) {
      expect(scaler.fit(natural, SIZE_PROFILES.vertical)).toEqual({
        scale: 0,
        offsetX: 0,
        offsetY: 0,
        width: 0,
        height: 0
      })
    }
  })

  it('⑫ 无效输入：负数 / NaN / Infinity / 视口为 0 都不抛错', () => {
    const invalidSources = [
      { w: -1, h: 100 },
      { w: 100, h: -1 },
      { w: Number.NaN, h: 100 },
      { w: 100, h: Number.NaN },
      { w: Number.POSITIVE_INFINITY, h: 100 },
      { w: 100, h: Number.NEGATIVE_INFINITY }
    ]

    for (const source of invalidSources) {
      expect(() => scaler.fit(source, SIZE_PROFILES.vertical)).not.toThrow()
      expect(scaler.fit(source, SIZE_PROFILES.vertical).width).toBe(0)
    }

    expect(() => scaler.fit({ w: 100, h: 100 }, { ...SIZE_PROFILES.card, w: 0 })).not.toThrow()
    expect(scaler.fit({ w: 100, h: 100 }, { ...SIZE_PROFILES.card, w: 0 }).width).toBe(0)
  })
})

describe('Scaler.fit 对齐两态', () => {
  it('1000×300 进 vertical：bottom → 620，center → 310', () => {
    const source = { w: 1000, h: 300 }
    const bottom = scaler.fit(source, SIZE_PROFILES.vertical, 'bottom')
    const center = scaler.fit(source, SIZE_PROFILES.vertical, 'center')

    expect(bottom.offsetY).toBe(620)
    expect(center.offsetY).toBe(310)
    expect([bottom.offsetX, bottom.width, bottom.height]).toEqual([0, 600, 180])
    expect([center.offsetX, center.width, center.height]).toEqual([0, 600, 180])
  })

  it('不传 align 时默认底对齐', () => {
    const source = { w: 1000, h: 300 }

    expect(scaler.fit(source, SIZE_PROFILES.vertical)).toEqual(
      scaler.fit(source, SIZE_PROFILES.vertical, 'bottom')
    )
  })

  it('profile.anchor 与 fit 的 align 同源', () => {
    expect(alignForProfile(SIZE_PROFILES.vertical)).toBe('bottom')
    expect(alignForProfile(SIZE_PROFILES.horizontal)).toBe('center')
    expect(alignForProfile(SIZE_PROFILES.square)).toBe('center')
    expect(alignForProfile(SIZE_PROFILES.card)).toBe('center')

    const source = { w: 1000, h: 300 }
    for (const profile of Object.values(SIZE_PROFILES)) {
      const byProfile = scaler.fit(source, profile, alignForProfile(profile))
      const explicit = scaler.fit(source, profile, profile.anchor === 'bottom-center' ? 'bottom' : 'center')
      expect(byProfile).toEqual(explicit)
    }
  })
})

describe('Scaler.windowSizeFor', () => {
  it('按 zoom 缩放并取整', () => {
    expect(scaler.windowSizeFor(SIZE_PROFILES.vertical, 0.5)).toEqual({ w: 300, h: 400 })
    expect(scaler.windowSizeFor(SIZE_PROFILES.vertical, 2)).toEqual({ w: 1200, h: 1600 })
    expect(scaler.windowSizeFor(SIZE_PROFILES.vertical, 1.5)).toEqual({ w: 900, h: 1200 })
  })

  it('card 档强制 zoom=1', () => {
    expect(scaler.windowSizeFor(SIZE_PROFILES.card, 2)).toEqual({ w: 380, h: 240 })
    expect(scaler.windowSizeFor(SIZE_PROFILES.card, 0.5)).toEqual({ w: 380, h: 240 })
  })

  it('非法 zoom 回落到 1', () => {
    expect(scaler.windowSizeFor(SIZE_PROFILES.vertical, 0)).toEqual({ w: 600, h: 800 })
    expect(scaler.windowSizeFor(SIZE_PROFILES.vertical, Number.NaN)).toEqual({ w: 600, h: 800 })
  })
})

describe('Scaler.contentRect', () => {
  it('扣除底部面板高度', () => {
    expect(scaler.contentRect({ w: 600, h: 800 }, 120)).toEqual({ x: 0, y: 0, w: 600, h: 680 })
  })

  it('面板高于窗口时高度为 0，不出现负数', () => {
    expect(scaler.contentRect({ w: 600, h: 800 }, 900)).toEqual({ x: 0, y: 0, w: 600, h: 0 })
  })

  it('非法输入返回全零', () => {
    expect(scaler.contentRect({ w: 0, h: 0 }, 100)).toEqual({ x: 0, y: 0, w: 0, h: 0 })
    expect(scaler.contentRect({ w: Number.NaN, h: 800 }, 100)).toEqual({ x: 0, y: 0, w: 0, h: 0 })
  })
})

describe('Scaler.cacheKey', () => {
  it('同模型同 profile 同 dpr 命中同一键', () => {
    const a = scaler.cacheKey('image', { w: 1000, h: 300 }, SIZE_PROFILES.vertical, 2)
    const b = scaler.cacheKey('image', { w: 1000, h: 300 }, SIZE_PROFILES.vertical, 2)

    expect(a).toBe(b)
  })

  it('kind / 尺寸 / profile / dpr 任一变化都产生不同键', () => {
    const base = scaler.cacheKey('image', { w: 1000, h: 300 }, SIZE_PROFILES.vertical, 2)

    expect(scaler.cacheKey('video', { w: 1000, h: 300 }, SIZE_PROFILES.vertical, 2)).not.toBe(base)
    expect(scaler.cacheKey('image', { w: 1001, h: 300 }, SIZE_PROFILES.vertical, 2)).not.toBe(base)
    expect(scaler.cacheKey('image', { w: 1000, h: 300 }, SIZE_PROFILES.horizontal, 2)).not.toBe(base)
    expect(scaler.cacheKey('image', { w: 1000, h: 300 }, SIZE_PROFILES.vertical, 1)).not.toBe(base)
  })
})
