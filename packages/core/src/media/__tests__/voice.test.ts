import { describe, expect, it } from 'vitest'
import {
  MAX_TTS_TEXT_LENGTH,
  MAX_VOICE_BYTES,
  MAX_VOICE_SECONDS,
  TtsSettingsError,
  VoiceMessageError,
  buildTtsRequest,
  buildVoiceMessage,
  estimateDuration,
  formatFromMime,
  validateTtsSettings
} from '../voice'

const settings = { baseUrl: 'http://127.0.0.1:9880/tts' }

describe('TTS 配置校验', () => {
  it('正常配置通过', () => {
    expect(validateTtsSettings(settings)).toEqual([])
  })

  it('地址为空被指出', () => {
    expect(validateTtsSettings({ baseUrl: '  ' })).toHaveLength(1)
  })

  it('地址不是 http(s) 被指出', () => {
    expect(validateTtsSettings({ baseUrl: 'localhost:9880' })).toHaveLength(1)
  })

  it('语速越界被指出', () => {
    expect(validateTtsSettings({ ...settings, speed: 3 })).toHaveLength(1)
    expect(validateTtsSettings({ ...settings, speed: 0.1 })).toHaveLength(1)
  })

  it('语速在范围内通过', () => {
    expect(validateTtsSettings({ ...settings, speed: 0.5 })).toEqual([])
    expect(validateTtsSettings({ ...settings, speed: 2 })).toEqual([])
  })

  it('不认识的格式被指出', () => {
    expect(validateTtsSettings({ ...settings, format: 'flac' as never })).toHaveLength(1)
  })
})

describe('TTS 请求构造', () => {
  it('默认 mp3', () => {
    const req = buildTtsRequest(settings, '你好')
    expect(req.accept).toBe('audio/mpeg')
    expect(req.body.format).toBe('mp3')
  })

  it('默认语速 1', () => {
    expect(buildTtsRequest(settings, '你好').body.speed).toBe(1)
  })

  it('有密钥时带 Authorization', () => {
    const req = buildTtsRequest({ ...settings, apiKey: 'k' }, '你好')
    expect(req.headers.Authorization).toBe('Bearer k')
  })

  it('没有密钥时不带', () => {
    expect(buildTtsRequest(settings, '你好').headers.Authorization).toBeUndefined()
  })

  it('空文本被拒', () => {
    expect(() => buildTtsRequest(settings, '  ')).toThrow(TtsSettingsError)
  })

  it('文本超长被拒', () => {
    expect(() => buildTtsRequest(settings, 'a'.repeat(MAX_TTS_TEXT_LENGTH + 1))).toThrow(
      TtsSettingsError
    )
  })

  it('地址不合法时先报配置错', () => {
    expect(() => buildTtsRequest({ baseUrl: '' }, '你好')).toThrow(TtsSettingsError)
  })
})

describe('GPT-SoVITS 请求构造', () => {
  const local = { baseUrl: 'http://127.0.0.1:9880/tts', protocol: 'gpt-sovits' as const }

  it('默认发 wav，并带上参考音频', () => {
    const req = buildTtsRequest({ ...local, refAudioPath: 'D:/voices/c.wav' }, '你好')
    expect(req.accept).toBe('audio/wav')
    expect(req.body.media_type).toBe('wav')
    expect(req.body.ref_audio_path).toBe('D:/voices/c.wav')
    expect(req.body.text_lang).toBe('zh')
    expect(req.body.prompt_lang).toBe('zh')
    expect(req.body.text).toBe('你好')
  })

  it('语言可以改', () => {
    const req = buildTtsRequest(
      { ...local, refAudioPath: 'x.wav', promptLang: 'ja' },
      'こんにちは'
    )
    expect(req.body.text_lang).toBe('ja')
    expect(req.body.prompt_lang).toBe('ja')
  })

  it('没填参考音频就报配置错，不发请求', () => {
    expect(() => buildTtsRequest(local, '你好')).toThrow(TtsSettingsError)
  })

  it('通用协议仍然发老字段', () => {
    const req = buildTtsRequest({ baseUrl: 'https://x/tts', protocol: 'generic' }, '你好')
    expect(req.body.format).toBe('mp3')
    expect(req.body.ref_audio_path).toBeUndefined()
  })
})

describe('语音消息', () => {
  const audio = new Uint8Array(100)

  it('正常消息', () => {
    const msg = buildVoiceMessage(audio, { format: 'mp3', durationSec: 3.4 })
    expect(msg.durationSec).toBe(3.4)
    expect(msg.format).toBe('mp3')
  })

  it('空音频被拒', () => {
    expect(() => buildVoiceMessage(new Uint8Array(0), { format: 'mp3', durationSec: 1 })).toThrow(
      VoiceMessageError
    )
  })

  it('超过体积上限被拒', () => {
    const big = new Uint8Array(MAX_VOICE_BYTES + 1)
    expect(() => buildVoiceMessage(big, { format: 'mp3', durationSec: 1 })).toThrow(
      VoiceMessageError
    )
  })

  it('超过时长上限被拒', () => {
    expect(() =>
      buildVoiceMessage(audio, { format: 'mp3', durationSec: MAX_VOICE_SECONDS + 1 })
    ).toThrow(VoiceMessageError)
  })

  it('刚好 60 秒可以', () => {
    expect(() =>
      buildVoiceMessage(audio, { format: 'mp3', durationSec: MAX_VOICE_SECONDS })
    ).not.toThrow()
  })

  it('时长非正数被拒', () => {
    expect(() => buildVoiceMessage(audio, { format: 'mp3', durationSec: 0 })).toThrow(
      VoiceMessageError
    )
  })

  it('时长保留一位小数', () => {
    expect(buildVoiceMessage(audio, { format: 'mp3', durationSec: 1.234 }).durationSec).toBe(1.2)
  })
})

describe('辅助函数', () => {
  it('MIME 反推格式', () => {
    expect(formatFromMime('audio/mpeg')).toBe('mp3')
    expect(formatFromMime('audio/ogg; codecs=opus')).toBe('ogg')
    expect(formatFromMime('text/plain')).toBeNull()
  })

  it('中文估算比等长英文长', () => {
    expect(estimateDuration('你好世界')).toBeGreaterThan(estimateDuration('abcd'))
  })

  it('空文本估 0', () => {
    expect(estimateDuration('')).toBe(0)
  })
})
