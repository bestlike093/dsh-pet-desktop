import { describe, expect, it } from 'vitest'
import { migrateSettings } from '../migrate.js'

const 默认语音 = {
  enabled: false,
  trigger: 'proactive',
  quietHours: { enabled: true, start: '22:00', end: '08:00' },
  provider: 'local',
  localUrl: 'http://127.0.0.1:9880',
  localProtocol: 'gpt-sovits',
  refAudioPath: '',
  promptLang: 'zh',
  cloud: { baseUrl: '', voice: '' },
  volume: 1,
  maxChars: 60,
  minIntervalSeconds: 8
}

describe('voice 设置迁移', () => {
  it('缺省时默认不出声，只在主动搭话时开口，22:00–08:00 免打扰', () => {
    const result = migrateSettings({ schemaVersion: 2 })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.voice).toEqual(默认语音)
  })

  it('接受合法的触发时机与免打扰时段', () => {
    const result = migrateSettings({
      schemaVersion: 2,
      voice: {
        enabled: true,
        trigger: 'manual',
        quietHours: { enabled: false, start: '23:30', end: '07:15' }
      }
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.voice).toEqual({
      enabled: true,
      trigger: 'manual',
      quietHours: { enabled: false, start: '23:30', end: '07:15' },
      provider: 'local',
      localUrl: 'http://127.0.0.1:9880',
      localProtocol: 'gpt-sovits',
      refAudioPath: '',
      promptLang: 'zh',
      cloud: { baseUrl: '', voice: '' },
      volume: 1,
      maxChars: 60,
      minIntervalSeconds: 8
    })
  })

  it('未知触发时机退回默认值', () => {
    const result = migrateSettings({ schemaVersion: 2, voice: { trigger: 'always' } })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.voice.trigger).toBe('proactive')
  })

  it('越界或格式错误的时间退回默认值', () => {
    const result = migrateSettings({
      schemaVersion: 2,
      voice: { quietHours: { start: '25:00', end: '7:5' } }
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.voice.quietHours.start).toBe('22:00')
    expect(result.value.voice.quietHours.end).toBe('08:00')
  })

  it('非布尔值不被当成真值', () => {
    const result = migrateSettings({ schemaVersion: 2, voice: { enabled: 'true' } })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.voice.enabled).toBe(false)
  })

  it('v1 迁移补上默认语音设置', () => {
    const result = migrateSettings({ schemaVersion: 1, nickname: '小鹿' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.voice).toEqual(默认语音)
  })

  it('本地协议只认两个值，参考音频保留用户填的路径', () => {
    const result = migrateSettings({
      schemaVersion: 2,
      voice: {
        localProtocol: 'whisper',
        refAudioPath: '  D:/voices/cyrene.wav  ',
        promptLang: 'ja'
      }
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.voice.localProtocol).toBe('gpt-sovits')
    expect(result.value.voice.refAudioPath).toBe('D:/voices/cyrene.wav')
    expect(result.value.voice.promptLang).toBe('ja')
  })

  it('参考音频缺省时是空串，不是默认值', () => {
    const result = migrateSettings({ schemaVersion: 2, voice: { refAudioPath: 123 } })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.voice.refAudioPath).toBe('')
  })
})
