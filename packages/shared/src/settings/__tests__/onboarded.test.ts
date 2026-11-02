import { describe, expect, it } from 'vitest'
import { migrateSettings } from '../migrate.js'

describe('首次引导标记', () => {
  it('新装时是 false，启动后该弹引导', () => {
    const result = migrateSettings({ schemaVersion: 2 })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.onboarded).toBe(false)
  })

  it('走完三步后保持 true', () => {
    const result = migrateSettings({ schemaVersion: 2, onboarded: true })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.onboarded).toBe(true)
  })

  it('只认真正的布尔值，字符串 "true" 不算走完', () => {
    const result = migrateSettings({ schemaVersion: 2, onboarded: 'true' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.onboarded).toBe(false)
  })

  it('v1 配置迁移后仍是 false，不会跳过引导', () => {
    const result = migrateSettings({ schemaVersion: 1, nickname: '示例' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.onboarded).toBe(false)
  })
})
