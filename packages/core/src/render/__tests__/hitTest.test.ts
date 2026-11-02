import { describe, expect, it } from 'vitest'
import { fullFrameRect, hitTest, toCanvasPoint } from '../hitTest.js'

const rect = { x: 10, y: 20, w: 100, h: 50 }

describe('矩形命中（B2-3）', () => {
  it('内部点命中', () => {
    expect(hitTest({ x: 50, y: 40 }, rect)).toBe(true)
  })

  it('边界左闭右开：左上角命中，右下角不命中', () => {
    expect(hitTest({ x: 10, y: 20 }, rect)).toBe(true)
    expect(hitTest({ x: 110, y: 20 }, rect)).toBe(false)
    expect(hitTest({ x: 10, y: 70 }, rect)).toBe(false)
  })

  it('紧邻边界内侧仍命中', () => {
    expect(hitTest({ x: 109.99, y: 69.99 }, rect)).toBe(true)
  })

  it('矩形外部不命中', () => {
    expect(hitTest({ x: 9, y: 40 }, rect)).toBe(false)
    expect(hitTest({ x: 50, y: 19 }, rect)).toBe(false)
    expect(hitTest({ x: 200, y: 200 }, rect)).toBe(false)
  })

  it('零尺寸矩形不命中，不把点算成命中', () => {
    expect(hitTest({ x: 0, y: 0 }, { x: 0, y: 0, w: 0, h: 10 })).toBe(false)
    expect(hitTest({ x: 0, y: 0 }, { x: 0, y: 0, w: 10, h: 0 })).toBe(false)
  })

  it('非有限数一律不命中，避免静默当成有效点击', () => {
    expect(hitTest({ x: Number.NaN, y: 0 }, rect)).toBe(false)
    expect(hitTest({ x: 0, y: Number.POSITIVE_INFINITY }, rect)).toBe(false)
    expect(hitTest({ x: 50, y: 40 }, { x: Number.NaN, y: 0, w: 10, h: 10 })).toBe(false)
  })

  it('整帧矩形与 profile 等大', () => {
    expect(fullFrameRect({ w: 240, h: 320 })).toEqual({ x: 0, y: 0, w: 240, h: 320 })
  })

  it('坐标缩放：页面坐标按比例换回画布逻辑坐标', () => {
    expect(toCanvasPoint({ x: 100, y: 200 }, { x: 2, y: 2 })).toEqual({ x: 50, y: 100 })
  })

  it('缩放为 0 或负数时返回 null，由调用方降级', () => {
    expect(toCanvasPoint({ x: 100, y: 200 }, { x: 0, y: 2 })).toBeNull()
    expect(toCanvasPoint({ x: 100, y: 200 }, { x: 2, y: -1 })).toBeNull()
  })
})
