import { describe, expect, it, vi } from 'vitest'
import { createRenderNoticePump, noticeFor } from '../renderNotice.js'
import type { SpriteRenderState } from '../spriteModel.js'

describe('渲染提示映射（B2-4 接线）', () => {
  it('idle / loading 显示加载提示，failed 显示失败提示', () => {
    expect(noticeFor('idle')).toBe('loading')
    expect(noticeFor('loading')).toBe('loading')
    expect(noticeFor('failed')).toBe('failed')
  })

  it('ready / disposed 不显示提示', () => {
    expect(noticeFor('ready')).toBe('none')
    expect(noticeFor('disposed')).toBe('none')
  })
})

describe('createRenderNoticePump', () => {
  function makeTarget() {
    return { show: vi.fn(), hide: vi.fn() }
  }

  it('首次进入 loading 会触发 show，重复 loading 不重复刷', () => {
    const target = makeTarget()
    const pump = createRenderNoticePump(target)

    expect(pump.push('idle')).toBe(true)
    expect(target.show).toHaveBeenCalledTimes(1)
    expect(target.show).toHaveBeenCalledWith('loading')

    expect(pump.push('loading')).toBe(false)
    expect(target.show).toHaveBeenCalledTimes(1)
  })

  it('加载失败切到 failed，并保持只显示一次', () => {
    const target = makeTarget()
    const pump = createRenderNoticePump(target)

    pump.push('loading')
    expect(pump.push('failed')).toBe(true)
    expect(target.show).toHaveBeenLastCalledWith('failed')

    expect(pump.push('failed')).toBe(false)
    expect(target.show).toHaveBeenCalledTimes(2)
  })

  it('从失败恢复到 ready 时隐藏提示', () => {
    const target = makeTarget()
    const pump = createRenderNoticePump(target)

    pump.push('failed')
    expect(pump.push('ready')).toBe(true)
    expect(target.hide).toHaveBeenCalledTimes(1)
  })

  it('disposed 不提示，避免盖在下一个模型上', () => {
    const target = makeTarget()
    const pump = createRenderNoticePump(target)

    pump.push('failed')
    expect(pump.push('disposed')).toBe(true)
    expect(target.hide).toHaveBeenCalledTimes(1)
    expect(pump.current).toBe('none')
  })

  it('dispose 之后不再触发 target', () => {
    const target = makeTarget()
    const pump = createRenderNoticePump(target)

    pump.dispose()
    expect(pump.push('failed')).toBe(false)
    expect(target.show).not.toHaveBeenCalled()
  })

  it('current 始终反映最后一次推送的提示种类', () => {
    const target = makeTarget()
    const pump = createRenderNoticePump(target)
    const states: SpriteRenderState[] = ['idle', 'loading', 'failed', 'ready']

    for (const state of states) pump.push(state)
    expect(pump.current).toBe('none')
  })
})
