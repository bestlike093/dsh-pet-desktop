import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '../../types/settings.js'
import { isPresenceQuietNow, isQuietNow, presenceQuietModeAt, shouldSpeakNow } from '../quiet.js'

const at = (hour: number, minute = 0) => new Date(2026, 10, 1, hour, minute, 0)

const quiet = (start: string, end: string, enabled = true) => ({ enabled, start, end })

describe('免打扰区间', () => {
  it('没开时永远不安静', () => {
    expect(isQuietNow(quiet('22:00', '08:00', false), at(23))).toBe(false)
  })

  it('普通区间：含起点，不含终点', () => {
    expect(isQuietNow(quiet('13:00', '14:00'), at(13))).toBe(true)
    expect(isQuietNow(quiet('13:00', '14:00'), at(13, 59))).toBe(true)
    expect(isQuietNow(quiet('13:00', '14:00'), at(14))).toBe(false)
    expect(isQuietNow(quiet('13:00', '14:00'), at(12, 59))).toBe(false)
  })

  it('跨零点：22:00 → 08:00 在午夜两侧都算安静', () => {
    expect(isQuietNow(quiet('22:00', '08:00'), at(22))).toBe(true)
    expect(isQuietNow(quiet('22:00', '08:00'), at(23, 30))).toBe(true)
    expect(isQuietNow(quiet('22:00', '08:00'), at(0, 10))).toBe(true)
    expect(isQuietNow(quiet('22:00', '08:00'), at(7, 59))).toBe(true)
    expect(isQuietNow(quiet('22:00', '08:00'), at(8))).toBe(false)
    expect(isQuietNow(quiet('22:00', '08:00'), at(12))).toBe(false)
  })

  it('起止相同或格式不对时不生效', () => {
    expect(isQuietNow(quiet('09:00', '09:00'), at(9))).toBe(false)
    expect(isQuietNow(quiet('25:00', '08:00'), at(23))).toBe(false)
  })
})

describe('夜间不扰（陪伴页）', () => {
  const presenceQuiet = (
    from: string,
    to: string,
    mode: string = 'urgentOnly',
    enabled = true
  ) => ({ enabled, from, to, mode, hideHud: false })

  it('未开启或时段不合法时一律 off', () => {
    expect(presenceQuietModeAt(at(23), presenceQuiet('23:00', '08:00', 'silent', false))).toBe(
      'off'
    )
    expect(presenceQuietModeAt(at(23), null)).toBe('off')
    expect(presenceQuietModeAt(at(23), presenceQuiet('09:00', '09:00'))).toBe('off')
    expect(presenceQuietModeAt(at(23), presenceQuiet('25:00', '08:00'))).toBe('off')
  })

  it('普通区间含起点、不含终点，并保留处理方式', () => {
    const q = presenceQuiet('13:00', '14:00', 'reduce')
    expect(presenceQuietModeAt(at(12, 59), q)).toBe('off')
    expect(presenceQuietModeAt(at(13), q)).toBe('reduce')
    expect(presenceQuietModeAt(at(13, 59), q)).toBe('reduce')
    expect(presenceQuietModeAt(at(14), q)).toBe('off')
  })

  it('跨零点在午夜两侧都生效', () => {
    const q = presenceQuiet('23:00', '08:00', 'silent')
    expect(presenceQuietModeAt(at(22, 59), q)).toBe('off')
    expect(presenceQuietModeAt(at(23), q)).toBe('silent')
    expect(presenceQuietModeAt(at(0, 10), q)).toBe('silent')
    expect(presenceQuietModeAt(at(8), q)).toBe('off')
    expect(isPresenceQuietNow(at(7, 59), q)).toBe(true)
  })

  it('未知处理方式退回 urgentOnly', () => {
    expect(presenceQuietModeAt(at(23), presenceQuiet('23:00', '08:00', 'loud'))).toBe(
      'urgentOnly'
    )
  })

  it('允许单数字小时', () => {
    expect(presenceQuietModeAt(at(9, 5), presenceQuiet('9:05', '10:05'))).toBe('urgentOnly')
  })
})

describe('出声判定', () => {
  const base = { ...DEFAULT_SETTINGS.voice, enabled: true, trigger: 'every' as const }

  it('总开关关着就不出声，点小喇叭也不', () => {
    const voice = { ...base, enabled: false }
    expect(shouldSpeakNow(voice, 'auto', at(12))).toBe(false)
    expect(shouldSpeakNow(voice, 'manual', at(12))).toBe(false)
  })

  it('免打扰里自动和手动都不出声', () => {
    expect(shouldSpeakNow(base, 'auto', at(23))).toBe(false)
    expect(shouldSpeakNow(base, 'manual', at(23))).toBe(false)
  })

  it('manual 模式下只响应小喇叭', () => {
    const voice = { ...base, trigger: 'manual' as const }
    expect(shouldSpeakNow(voice, 'auto', at(12))).toBe(false)
    expect(shouldSpeakNow(voice, 'manual', at(12))).toBe(true)
  })

  it('白天按触发时机放行', () => {
    expect(shouldSpeakNow(base, 'auto', at(12))).toBe(true)
  })
})
