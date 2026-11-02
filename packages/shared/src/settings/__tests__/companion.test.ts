import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '../../types/settings.js'
import { migrateSettings } from '../migrate.js'

describe('companion 设置迁移', () => {
  it('缺省时记忆与聊天关闭，陪伴任务全部关闭', () => {
    const result = migrateSettings({ schemaVersion: 2 })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.value.locale).toBe('zh-CN')
    expect(result.value.companion).toEqual(DEFAULT_SETTINGS.companion)
    expect(result.value.companion.memory.enabled).toBe(false)
    expect(result.value.companion.chat.enabled).toBe(false)
    expect(result.value.companion.care.dailyReview.enabled).toBe(false)
    expect(result.value.companion.care.caseReview.enabled).toBe(false)
    expect(result.value.companion.care.questionnaire.enabled).toBe(false)
    expect(result.value.companion.care.maslow.enabled).toBe(false)
  })

  it('只给一个子项时，其余保持默认（深合并）', () => {
    const result = migrateSettings({
      schemaVersion: 2,
      companion: { memory: { enabled: true } }
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.value.companion.memory.enabled).toBe(true)
    expect(result.value.companion.memory.maxItems).toBe(500)
    expect(result.value.companion.memory.summarizeEvery).toBe(8)
    expect(result.value.companion.chat.model).toBe('deepseek-chat')
    expect(result.value.companion.care.dailyReview.at).toBe('22:30')
  })

  it('接受合法的聊天参数与陪伴时刻', () => {
    const result = migrateSettings({
      schemaVersion: 2,
      locale: 'en-US',
      companion: {
        chat: { enabled: true, model: 'deepseek-reasoner', maxTokens: 2000, temperature: 1.2 },
        care: {
          dailyReview: { enabled: true, at: '23:45' },
          caseReview: { enabled: true, at: '00:10' },
          maslow: { enabled: true }
        }
      }
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.value.locale).toBe('en-US')
    expect(result.value.companion.chat.model).toBe('deepseek-reasoner')
    expect(result.value.companion.chat.maxTokens).toBe(2000)
    expect(result.value.companion.care.dailyReview).toEqual({ enabled: true, at: '23:45' })
    expect(result.value.companion.care.caseReview).toEqual({ enabled: true, at: '00:10' })
    expect(result.value.companion.care.maslow.enabled).toBe(true)
  })

  it('越界数值被夹取，不整体拒绝', () => {
    const result = migrateSettings({
      schemaVersion: 2,
      companion: {
        memory: { maxItems: 1, summarizeEvery: 0 },
        chat: { maxTokens: 999_999, temperature: 5, historyLimit: 999 },
        care: { dailyTokenBudget: -10 }
      }
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.value.companion.memory.maxItems).toBe(50)
    expect(result.value.companion.memory.summarizeEvery).toBe(1)
    expect(result.value.companion.chat.maxTokens).toBe(8_000)
    expect(result.value.companion.chat.temperature).toBe(2)
    expect(result.value.companion.chat.historyLimit).toBe(50)
    expect(result.value.companion.care.dailyTokenBudget).toBe(0)
  })

  it('非法时刻与非法语言退回默认', () => {
    const result = migrateSettings({
      schemaVersion: 2,
      locale: 'fr-FR',
      companion: { care: { dailyReview: { at: '25:00' }, caseReview: { at: '7:5' } } }
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.value.locale).toBe('zh-CN')
    expect(result.value.companion.care.dailyReview.at).toBe('22:30')
    expect(result.value.companion.care.caseReview.at).toBe('23:00')
  })

  it('布尔项只认 true/false，字符串不被当成真值', () => {
    const result = migrateSettings({
      schemaVersion: 2,
      companion: { chat: { enabled: 'true' }, memory: { enabled: 1 } }
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.value.companion.chat.enabled).toBe(false)
    expect(result.value.companion.memory.enabled).toBe(false)
  })

  it('v1 迁移补上默认陪伴设置', () => {
    const result = migrateSettings({ schemaVersion: 1, nickname: '小鹿' })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.value.locale).toBe('zh-CN')
    expect(result.value.companion).toEqual(DEFAULT_SETTINGS.companion)
  })

  it('追加人格说明保留原文，超长截断', () => {
    const long = 'a'.repeat(3000)
    const result = migrateSettings({
      schemaVersion: 2,
      companion: { persona: { extraPrompt: long } }
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.value.companion.persona.extraPrompt).toHaveLength(2000)
    expect(result.value.companion.persona.enabled).toBe(true)
  })
})
