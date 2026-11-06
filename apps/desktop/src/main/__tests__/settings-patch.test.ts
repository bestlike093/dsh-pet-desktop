import { describe, expect, it } from 'vitest'
import { mergeLayer, sanitizeSettingsPatch } from '../settings-patch.js'

describe('mergeLayer', () => {
  it('深合并保留未提及的子项', () => {
    const base = {
      companion: { chat: { provider: 'deepseek', model: 'a' }, memory: { enabled: true } }
    }
    const out = mergeLayer(base, { companion: { chat: { model: 'b' } } }) as typeof base
    expect(out.companion.chat).toEqual({ provider: 'deepseek', model: 'b' })
    expect(out.companion.memory).toEqual({ enabled: true })
  })

  it('数组整体替换，不逐项合并', () => {
    expect(mergeLayer({ a: [1, 2] }, { a: [3] })).toEqual({ a: [3] })
  })

  it('null / 标量覆盖整层', () => {
    expect(mergeLayer({ a: { b: 1 } }, { a: null })).toEqual({ a: null })
    expect(mergeLayer({ a: { b: 1 } }, { a: 2 })).toEqual({ a: 2 })
  })
})

describe('sanitizeSettingsPatch', () => {
  it('脏字段被丢，已知字段留', () => {
    expect(sanitizeSettingsPatch({ llmApiKey: 'x', nickname: '小满' })).toEqual({ nickname: '小满' })
  })

  it('已知对象的未知子键被丢，已知子键留', () => {
    expect(sanitizeSettingsPatch({ window: { scale: 0.8, evil: 1 } })).toEqual({
      window: { scale: 0.8 }
    })
  })

  it('已知对象的子键全是脏键时返回空对象', () => {
    expect(sanitizeSettingsPatch({ window: { evil: 1 } })).toEqual({ window: {} })
  })

  it('null → {} 不抛（新契约回归）', () => {
    expect(() => sanitizeSettingsPatch(null)).not.toThrow()
    expect(sanitizeSettingsPatch(null)).toEqual({})
  })

  it('边界输入不抛，返回空对象', () => {
    expect(sanitizeSettingsPatch(null)).toEqual({})
    expect(sanitizeSettingsPatch(undefined)).toEqual({})
    expect(sanitizeSettingsPatch('x')).toEqual({})
    expect(sanitizeSettingsPatch([1, 2])).toEqual({})
    expect(sanitizeSettingsPatch(42)).toEqual({})
  })

  it('已知标量字段原样保留', () => {
    expect(sanitizeSettingsPatch({ showHud: true, hudAlpha: 0.6 })).toEqual({
      showHud: true,
      hudAlpha: 0.6
    })
  })

  it('channels.qq 放行，未知渠道与未知字段被丢', () => {
    expect(
      sanitizeSettingsPatch({
        channels: {
          qq: { enabled: true, transport: 'gateway', appId: '123', evil: 'x' },
          wechat: { enabled: true }
        }
      })
    ).toEqual({ channels: { qq: { enabled: true, transport: 'gateway', appId: '123' } } })
  })

  it('非对象 channels 被拒绝', () => {
    expect(sanitizeSettingsPatch({ channels: 'x' })).toEqual({})
    expect(sanitizeSettingsPatch({ channels: [1] })).toEqual({})
  })

  it('hudName 进入白名单', () => {
    expect(sanitizeSettingsPatch({ hudName: '小昔' })).toEqual({ hudName: '小昔' })
  })
})
