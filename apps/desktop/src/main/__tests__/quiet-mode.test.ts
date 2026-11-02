import { describe, expect, it } from 'vitest'
import { quietModeAt, type QuietHours } from '../quiet-mode.js'

const at = (hour: number, minute: number) => new Date(2026, 0, 1, hour, minute)
const quiet = (patch: QuietHours = {}): QuietHours => ({
  enabled: true,
  from: '23:00',
  to: '08:00',
  mode: 'silent',
  ...patch
})

describe('quietModeAt 时间边界', () => {
  it('未启用时一律 off', () => {
    expect(quietModeAt(at(23, 30), quiet({ enabled: false }))).toBe('off')
    expect(quietModeAt(at(23, 30), null)).toBe('off')
    expect(quietModeAt(at(23, 30), undefined)).toBe('off')
  })

  it('不跨零点：起点含、终点不含', () => {
    const q = quiet({ from: '09:00', to: '18:00' })
    expect(quietModeAt(at(8, 59), q)).toBe('off')
    expect(quietModeAt(at(9, 0), q)).toBe('silent')
    expect(quietModeAt(at(17, 59), q)).toBe('silent')
    expect(quietModeAt(at(18, 0), q)).toBe('off')
  })

  it('跨零点：23:00 含、08:00 不含', () => {
    const q = quiet({ from: '23:00', to: '08:00' })
    expect(quietModeAt(at(22, 59), q)).toBe('off')
    expect(quietModeAt(at(23, 0), q)).toBe('silent')
    expect(quietModeAt(at(0, 0), q)).toBe('silent')
    expect(quietModeAt(at(7, 59), q)).toBe('silent')
    expect(quietModeAt(at(8, 0), q)).toBe('off')
  })

  it('分钟边界按分钟比较，秒不影响', () => {
    const q = quiet({ from: '22:30', to: '23:30' })
    expect(quietModeAt(at(22, 29), q)).toBe('off')
    expect(quietModeAt(at(22, 30), q)).toBe('silent')
    expect(quietModeAt(new Date(2026, 0, 1, 22, 30, 59), q)).toBe('silent')
    expect(quietModeAt(at(23, 29), q)).toBe('silent')
    expect(quietModeAt(at(23, 30), q)).toBe('off')
  })

  it('单数字小时合法', () => {
    const q = quiet({ from: '9:05', to: '10:05' })
    expect(quietModeAt(at(9, 4), q)).toBe('off')
    expect(quietModeAt(at(9, 5), q)).toBe('silent')
    expect(quietModeAt(at(10, 4), q)).toBe('silent')
    expect(quietModeAt(at(10, 5), q)).toBe('off')
  })

  it('from === to 视为未开启', () => {
    expect(quietModeAt(at(23, 0), quiet({ from: '08:00', to: '08:00' }))).toBe('off')
  })

  it('非法时间格式不抛，按未开启处理', () => {
    for (const bad of ['24:00', '23:60', '9:5', 'ab', '', null, undefined, 42]) {
      expect(quietModeAt(at(23, 30), quiet({ from: bad }))).toBe('off')
      expect(quietModeAt(at(23, 30), quiet({ to: bad }))).toBe('off')
    }
  })

  it('模式非法时降级为 urgentOnly', () => {
    expect(quietModeAt(at(23, 30), quiet({ mode: 'silent' }))).toBe('silent')
    expect(quietModeAt(at(23, 30), quiet({ mode: 'reduce' }))).toBe('reduce')
    expect(quietModeAt(at(23, 30), quiet({ mode: 'loud' }))).toBe('urgentOnly')
    expect(quietModeAt(at(23, 30), quiet({ mode: undefined }))).toBe('urgentOnly')
  })
})
