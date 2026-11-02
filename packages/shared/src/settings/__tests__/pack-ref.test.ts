import { describe, expect, it } from 'vitest'
import { settingsV2ToV21 } from '../../contracts/settings.js'
import { DEFAULT_SETTINGS } from '../../types/settings.js'
import { migrateSettings } from '../migrate.js'

/** 只关心是否被拒：拒绝时必须回落到 null 之外的空串。 */
const refOf = (raw: unknown): string => {
  const result = migrateSettings({ ...DEFAULT_SETTINGS, ...(raw as Record<string, unknown>) })
  if (!result.ok) throw result.error
  return result.value.bubble.background
}

describe('素材包引用校验', () => {
  it('接受 pack:<id>:<相对路径>', () => {
    expect(refOf({ bubble: { ...DEFAULT_SETTINGS.bubble, background: 'pack:cyrene:bubble.png' } })).toBe(
      'pack:cyrene:bubble.png'
    )
    expect(refOf({ bubble: { ...DEFAULT_SETTINGS.bubble, background: 'pack:pink-2:b/c.webp' } })).toBe(
      'pack:pink-2:b/c.webp'
    )
  })

  it('拒绝越权与畸形引用', () => {
    expect(refOf({ bubble: { ...DEFAULT_SETTINGS.bubble, background: 'pack:a:../../etc/passwd' } })).toBe('')
    expect(refOf({ bubble: { ...DEFAULT_SETTINGS.bubble, background: 'pack:a:/abs.png' } })).toBe('')
    expect(refOf({ bubble: { ...DEFAULT_SETTINGS.bubble, background: 'pack:a:b\\c.png' } })).toBe('')
    expect(refOf({ bubble: { ...DEFAULT_SETTINGS.bubble, background: 'pack:a/b:file.png' } })).toBe('')
    expect(refOf({ bubble: { ...DEFAULT_SETTINGS.bubble, background: 'file:///C:/x.png' } })).toBe('')
    expect(refOf({ bubble: { ...DEFAULT_SETTINGS.bubble, background: 42 } })).toBe('')
  })

  it('空串表示用内置素材', () => {
    expect(refOf({ bubble: { ...DEFAULT_SETTINGS.bubble, background: '' } })).toBe('')
    expect(refOf({})).toBe('')
  })
})

describe('图标与贴纸来源', () => {
  const parse = (raw: Record<string, unknown>) => {
    const result = migrateSettings({ ...DEFAULT_SETTINGS, ...raw })
    if (!result.ok) throw result.error
    return result.value
  }

  it('默认全部为空，代表用内置素材、贴纸关闭', () => {
    const value = parse({})
    expect(value.icon).toEqual({ tray: '', app: '' })
    expect(value.sticker).toEqual({ source: '' })
  })

  it('合法的包引用会被保留', () => {
    const value = parse({
      icon: { tray: 'pack:cyrene:tray.ico', app: 'pack:cyrene:app.png' },
      sticker: { source: 'pack:cyrene:emoji/happy.png' }
    })
    expect(value.icon.tray).toBe('pack:cyrene:tray.ico')
    expect(value.icon.app).toBe('pack:cyrene:app.png')
    expect(value.sticker.source).toBe('pack:cyrene:emoji/happy.png')
  })

  it('越权引用被清空而不是原样保留', () => {
    const value = parse({
      icon: { tray: 'pack:cyrene/../../x.ico', app: 'C:\\Windows\\x.png' },
      sticker: { source: 'pack:../x.png' }
    })
    expect(value.icon.tray).toBe('')
    expect(value.icon.app).toBe('')
    expect(value.sticker.source).toBe('')
  })
})

describe('气泡字体与底图', () => {
  it('字体可以指向包内文件', () => {
    const result = migrateSettings({
      ...DEFAULT_SETTINGS,
      bubble: { ...DEFAULT_SETTINGS.bubble, fontFamily: 'pack:cyrene:font/cyrene.woff2' }
    })
    if (!result.ok) throw result.error
    expect(result.value.bubble.fontFamily).toBe('pack:cyrene:font/cyrene.woff2')
  })

  it('字体仍保留旧的系统字体键', () => {
    const result = migrateSettings({
      ...DEFAULT_SETTINGS,
      bubble: { ...DEFAULT_SETTINGS.bubble, fontFamily: 'system-ui' }
    })
    if (!result.ok) throw result.error
    expect(result.value.bubble.fontFamily).toBe('system-ui')
  })

  it('切片像素被夹到 4..64', () => {
    const sliceOf = (backgroundSlice: number) => {
      const result = migrateSettings({
        ...DEFAULT_SETTINGS,
        bubble: { ...DEFAULT_SETTINGS.bubble, backgroundSlice }
      })
      if (!result.ok) throw result.error
      return result.value.bubble.backgroundSlice
    }
    expect(sliceOf(1)).toBe(4)
    expect(sliceOf(999)).toBe(64)
    expect(sliceOf(12)).toBe(12)
  })
})

describe('迁移与契约', () => {
  it('v1 配置补全新字段而不是留空对象', () => {
    const result = migrateSettings({ schemaVersion: 1, nickname: '柒柒' })
    if (!result.ok) throw result.error
    expect(result.value.icon).toEqual({ tray: '', app: '' })
    expect(result.value.sticker).toEqual({ source: '' })
    expect(result.value.bubble.background).toBe('')
  })

  it('icon / sticker 属于 v2 schema，不进 _legacy', () => {
    const value = {
      ...DEFAULT_SETTINGS,
      icon: { tray: 'pack:cyrene:tray.ico', app: '' },
      sticker: { source: 'pack:cyrene:a.png' }
    }
    const v21 = settingsV2ToV21(value)
    expect(v21._legacy).toBeUndefined()
  })
})
