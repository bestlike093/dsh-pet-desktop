import { describe, expect, it } from 'vitest'

import {
  TtsProviderError,
  countBillableChars,
  createCloudTtsProvider,
  createLocalTtsProvider,
  estimateTtsCostCny,
  formatTtsCost,
  isAudioMime
} from '../ttsProvider.js'

function audioResponse(bytes = [1, 2, 3], type = 'audio/mpeg'): Response {
  return new Response(new Uint8Array(bytes), { headers: { 'content-type': type } })
}

describe('计费字符数', () => {
  it('空白不计费', () => {
    expect(countBillableChars('你 好\n呀')).toBe(3)
  })

  it('emoji 按一个字符算，不按 UTF-16 单元', () => {
    expect(countBillableChars('♪')).toBe(1)
    expect('♪'.length).toBe(1)
    expect(countBillableChars('🌸')).toBe(1)
    expect('🌸'.length).toBe(2)
  })

  it('空文本是 0', () => {
    expect(countBillableChars('   ')).toBe(0)
  })
})

describe('费用估算', () => {
  it('每千字符单价按字符数折算', () => {
    expect(estimateTtsCostCny('一'.repeat(1000), 0.2)).toBeCloseTo(0.2, 6)
    expect(estimateTtsCostCny('一'.repeat(500), 0.2)).toBeCloseTo(0.1, 6)
  })

  it('单价非法时返回 0，不算出 NaN', () => {
    expect(estimateTtsCostCny('你好', 0)).toBe(0)
    expect(estimateTtsCostCny('你好', Number.NaN)).toBe(0)
    expect(estimateTtsCostCny('你好', -1)).toBe(0)
  })

  it('文案带 ≈，小额保留四位', () => {
    expect(formatTtsCost(0)).toBe('≈¥0')
    expect(formatTtsCost(0.0012)).toBe('≈¥0.0012')
    expect(formatTtsCost(1.5)).toBe('≈¥1.50')
  })
})

describe('云端 provider', () => {
  const base = {
    baseUrl: 'https://tts.example.com/synth',
    apiKey: 'sk-test',
    pricePerKCharCny: 0.2
  }

  it('拿到音频就返回，并标成按字符计费', async () => {
    const provider = createCloudTtsProvider({
      ...base,
      fetchImpl: async () => audioResponse()
    })

    expect(provider.billable).toBe(true)
    expect(provider.kind).toBe('cloud')

    const result = await provider.synthesize({ text: '你好呀' })
    expect(result.audio.byteLength).toBe(3)
    expect(result.format).toBe('mp3')
    expect(result.durationSec).toBeGreaterThan(0)
  })

  it('把 Key 放进 Authorization，不写进 body', async () => {
    let seen: RequestInit | undefined
    const provider = createCloudTtsProvider({
      ...base,
      fetchImpl: async (_url, init) => {
        seen = init
        return audioResponse()
      }
    })

    await provider.synthesize({ text: '你好' })
    const headers = seen?.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer sk-test')
    expect(String(seen?.body)).not.toContain('sk-test')
  })

  it('缺少 Key 直接拒，不发请求', async () => {
    let called = false
    const provider = createCloudTtsProvider({
      ...base,
      apiKey: '   ',
      fetchImpl: async () => {
        called = true
        return audioResponse()
      }
    })

    await expect(provider.synthesize({ text: '你好' })).rejects.toBeInstanceOf(TtsProviderError)
    expect(called).toBe(false)
  })

  it('非 2xx 报 http', async () => {
    const provider = createCloudTtsProvider({
      ...base,
      fetchImpl: async () => new Response('nope', { status: 500 })
    })

    await expect(provider.synthesize({ text: '你好' })).rejects.toMatchObject({ reason: 'http' })
  })

  it('200 但回 json 时不当音频收下', async () => {
    const provider = createCloudTtsProvider({
      ...base,
      fetchImpl: async () => audioResponse([1], 'application/json')
    })

    await expect(provider.synthesize({ text: '你好' })).rejects.toMatchObject({
      reason: 'not-audio'
    })
  })

  it('空音频报 empty', async () => {
    const provider = createCloudTtsProvider({
      ...base,
      fetchImpl: async () => audioResponse([])
    })

    await expect(provider.synthesize({ text: '你好' })).rejects.toMatchObject({ reason: 'empty' })
  })

  it('超长文本在发请求前就拒', async () => {
    let called = false
    const provider = createCloudTtsProvider({
      ...base,
      maxTextLength: 5,
      fetchImpl: async () => {
        called = true
        return audioResponse()
      }
    })

    await expect(provider.synthesize({ text: '一二三四五六' })).rejects.toMatchObject({
      reason: 'settings'
    })
    expect(called).toBe(false)
  })

  it('取消会翻成 aborted', async () => {
    const provider = createCloudTtsProvider({
      ...base,
      fetchImpl: async () => {
        const error = new Error('aborted')
        error.name = 'AbortError'
        throw error
      }
    })

    await expect(provider.synthesize({ text: '你好' })).rejects.toMatchObject({
      reason: 'aborted'
    })
  })
})

describe('本地 provider', () => {
  it('回环地址可用，且不计费', () => {
    const provider = createLocalTtsProvider({ baseUrl: 'http://127.0.0.1:9880/tts' })
    expect(provider.kind).toBe('local')
    expect(provider.billable).toBe(false)
  })

  it('localhost 也算回环', () => {
    expect(() => createLocalTtsProvider({ baseUrl: 'http://localhost:9880/tts' })).not.toThrow()
  })

  it('非回环地址拒绝构造，避免文本被发到外面', () => {
    expect(() => createLocalTtsProvider({ baseUrl: 'https://tts.example.com/synth' })).toThrow(
      TtsProviderError
    )
    expect(() => createLocalTtsProvider({ baseUrl: 'http://192.168.1.10:9880/tts' })).toThrow(
      TtsProviderError
    )
  })

  it('构造非法地址也拒绝', () => {
    expect(() => createLocalTtsProvider({ baseUrl: 'not a url' })).toThrow(TtsProviderError)
  })

  it('不带 Authorization', async () => {
    let seen: RequestInit | undefined
    const provider = createLocalTtsProvider({
      baseUrl: 'http://127.0.0.1:9880/tts',
      // 这条只关心鉴权：走通用协议，省掉参考音频。
      protocol: 'generic',
      fetchImpl: async (_url, init) => {
        seen = init
        return audioResponse([1, 2], 'audio/wav')
      }
    })

    const result = await provider.synthesize({ text: '你好' })
    expect(result.format).toBe('mp3')

    const headers = seen?.headers as Record<string, string>
    expect(headers.Authorization).toBeUndefined()
  })

  it('默认按 GPT-SoVITS 发，回 wav', async () => {
    let body: Record<string, unknown> = {}
    const provider = createLocalTtsProvider({
      baseUrl: 'http://127.0.0.1:9880/tts',
      refAudioPath: 'D:/voices/c.wav',
      fetchImpl: async (_url, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>
        return audioResponse([1, 2, 3], 'audio/wav')
      }
    })

    const result = await provider.synthesize({ text: '你好' })
    expect(result.format).toBe('wav')
    expect(body.ref_audio_path).toBe('D:/voices/c.wav')
    expect(body.media_type).toBe('wav')
  })

  it('没填参考音频时报 settings，一个请求都不发', async () => {
    let called = false
    const provider = createLocalTtsProvider({
      baseUrl: 'http://127.0.0.1:9880/tts',
      fetchImpl: async () => {
        called = true
        return audioResponse([1], 'audio/wav')
      }
    })

    await expect(provider.synthesize({ text: '你好' })).rejects.toThrow(TtsProviderError)
    expect(called).toBe(false)
  })
})

describe('MIME 判断', () => {
  it('认得 audio/*，不认 json', () => {
    expect(isAudioMime('audio/mpeg')).toBe(true)
    expect(isAudioMime('audio/ogg; codecs=opus')).toBe(true)
    expect(isAudioMime('application/json')).toBe(false)
    expect(isAudioMime('')).toBe(false)
  })
})
