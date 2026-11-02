import { describe, expect, it } from 'vitest'
import { DOCK_MARGIN, clampBoundsToWorkArea, dockBoundsToBottomRight } from '../window-bounds.js'

const area = { x: 0, y: 0, width: 1920, height: 1040 }

describe('clampBoundsToWorkArea', () => {
  it('区域内原样保留', () => {
    expect(clampBoundsToWorkArea({ x: 100, y: 200, width: 340, height: 520 }, area)).toEqual({
      x: 100,
      y: 200,
      width: 340,
      height: 520
    })
  })

  it('右下越界时夹回', () => {
    expect(clampBoundsToWorkArea({ x: 1800, y: 900, width: 340, height: 520 }, area)).toEqual({
      x: 1580,
      y: 520,
      width: 340,
      height: 520
    })
  })

  it('左上越界时夹回', () => {
    expect(clampBoundsToWorkArea({ x: -100, y: -50, width: 340, height: 520 }, area)).toEqual({
      x: 0,
      y: 0,
      width: 340,
      height: 520
    })
  })

  it('尺寸超过工作区时压到工作区', () => {
    expect(clampBoundsToWorkArea({ x: 0, y: 0, width: 3000, height: 2000 }, area)).toEqual({
      x: 0,
      y: 0,
      width: 1920,
      height: 1040
    })
  })

  it('宽高为 0 或负数时抬到 1', () => {
    expect(clampBoundsToWorkArea({ x: 10, y: 10, width: 0, height: -5 }, area)).toMatchObject({
      width: 1,
      height: 1
    })
  })

  it('小数四舍五入', () => {
    expect(clampBoundsToWorkArea({ x: 10.4, y: 10.6, width: 339.6, height: 519.5 }, area)).toEqual({
      x: 10,
      y: 11,
      width: 340,
      height: 520
    })
  })

  it('副屏工作区带偏移时按绝对坐标夹回', () => {
    const second = { x: 1920, y: -200, width: 1280, height: 1024 }
    expect(clampBoundsToWorkArea({ x: 2000, y: -300, width: 340, height: 520 }, second)).toEqual({
      x: 2000,
      y: -200,
      width: 340,
      height: 520
    })
  })
})

describe('dockBoundsToBottomRight', () => {
  it('贴右下角并留 24px', () => {
    expect(dockBoundsToBottomRight({ width: 340, height: 520 }, area)).toEqual({
      x: 1920 - 340 - DOCK_MARGIN,
      y: 1040 - 520 - DOCK_MARGIN,
      width: 340,
      height: 520
    })
  })

  it('非默认 margin 生效', () => {
    expect(dockBoundsToBottomRight({ width: 340, height: 520 }, area, 8)).toEqual({
      x: 1920 - 340 - 8,
      y: 1040 - 520 - 8,
      width: 340,
      height: 520
    })
  })

  it('尺寸超过工作区时先压到工作区再贴边', () => {
    expect(dockBoundsToBottomRight({ width: 3000, height: 2000 }, area)).toEqual({
      x: DOCK_MARGIN * -1,
      y: DOCK_MARGIN * -1,
      width: 1920,
      height: 1040
    })
  })

  it('副屏工作区按偏移定位', () => {
    const second = { x: 1920, y: 0, width: 1280, height: 1024 }
    expect(dockBoundsToBottomRight({ width: 340, height: 520 }, second)).toEqual({
      x: 1920 + 1280 - 340 - DOCK_MARGIN,
      y: 1024 - 520 - DOCK_MARGIN,
      width: 340,
      height: 520
    })
  })
})
