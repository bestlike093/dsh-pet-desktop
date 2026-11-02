import { beforeEach, describe, expect, it } from 'vitest'
import { registerVoiceChannels, type VoiceChannelDeps } from '../ipc/voice.js'

const handlers = new Map<string, (...args: any[]) => unknown>()
const held = (globalThis as Record<string, any>).__voiceHeldWindows as {
  has: (id: number) => boolean
  size: (id?: number) => number
  clear: () => void
}

let settings: Record<string, any> = {}
let planCalls: Array<Record<string, any>> = []
let planResult: Record<string, any> = {}
let synthesize: () => Promise<Record<string, any>> = async () => ({ format: 'wav', audio: 'base64' })
let dialogResult: { canceled: boolean; filePaths: string[] } = { canceled: false, filePaths: ['/ref.wav'] }

const deps: VoiceChannelDeps = {
  registerChannel: (channel, listener) => {
    handlers.set(channel, listener)
  },
  getSettings: () => settings,
  planSpeak: (input) => {
    planCalls.push(input)
    return planResult
  },
  createLocalTtsProvider: () => ({ synthesize: () => synthesize() }),
  dialog: { showOpenDialog: async () => dialogResult },
  log: () => undefined
}

function makeSender(id: number) {
  const listeners = new Map<string, () => void>()
  return {
    id,
    once(event: string, callback: () => void) {
      listeners.set(event, callback)
    },
    destroy() {
      listeners.get('destroyed')?.()
    }
  }
}

beforeEach(() => {
  handlers.clear()
  held.clear()
  settings = { voice: {} }
  planCalls = []
  planResult = {
    ok: true,
    text: '你好',
    endpoint: 'http://127.0.0.1:9880/tts',
    refAudioPath: '/ref.wav',
    protocol: 'gpt-sovits',
    promptLang: 'zh',
    autoSpeakAt: null
  }
  synthesize = async () => ({ format: 'wav', audio: 'base64' })
  dialogResult = { canceled: false, filePaths: ['/ref.wav'] }
  registerVoiceChannels(deps)
})

const speak = (event: Record<string, any>, payload: Record<string, any>) =>
  handlers.get('pet:voice:speak')!(event, payload)

describe('voice:speak', () => {
  it('plan 拒绝时原样回 reason，不发起合成', async () => {
    planResult = { ok: false, reason: 'silent' }
    await expect(speak({}, { text: '你好' })).resolves.toEqual({ ok: false, reason: 'silent' })
  })

  it('合成成功回音频数据', async () => {
    await expect(speak({}, { text: '你好' })).resolves.toEqual({ ok: true, format: 'wav', audio: 'base64' })
  })

  it('合成失败回 tts-failed，不向渲染抛', async () => {
    synthesize = async () => {
      throw new Error('boom')
    }
    await expect(speak({}, { text: '你好' })).resolves.toEqual({
      ok: false,
      reason: 'tts-failed',
      message: 'boom'
    })
  })

  it('并发 second 直接回 busy，不启动第二次合成', async () => {
    let release: (() => void) | null = null
    let calls = 0
    synthesize = () => {
      calls += 1
      return new Promise((resolve) => {
        release = () => resolve({ format: 'wav', audio: 'base64' })
      })
    }

    const first = speak({}, { text: '你好' })
    await Promise.resolve()

    await expect(speak({}, { text: '你好' })).resolves.toEqual({ ok: false, reason: 'busy' })
    expect(calls).toBe(1)

    ;(release as (() => void) | null)?.()
    await expect(first).resolves.toMatchObject({ ok: true })
  })

  it('auto 推进节流时间，manual 不推进', async () => {
    planResult.autoSpeakAt = 1000
    await speak({}, { text: '一', reason: 'auto' })
    expect(planCalls[0]?.lastAutoSpeakAt).toBe(0)

    planResult.autoSpeakAt = null
    await speak({}, { text: '二', reason: 'manual' })
    expect(planCalls[1]?.lastAutoSpeakAt).toBe(1000)

    await speak({}, { text: '三', reason: 'auto' })
    expect(planCalls[2]?.lastAutoSpeakAt).toBe(1000)
  })
})

describe('voice 软持有生命周期', () => {
  it('hide 不释放持有，sender 销毁才清空', async () => {
    const sender = makeSender(7)
    await speak({ sender }, { text: '你好' })

    expect(held.has(7)).toBe(true)
    // 窗口 hide 不触发 destroyed，持有集合保持不变。
    expect(held.has(7)).toBe(true)

    sender.destroy()
    expect(held.has(7)).toBe(false)
  })

  it('窗口重建后旧 id 无订阅，新 id 只有一条', async () => {
    const oldSender = makeSender(7)
    await speak({ sender: oldSender }, { text: '旧窗口' })
    oldSender.destroy()
    expect(held.has(7)).toBe(false)

    const newSender = makeSender(8)
    await speak({ sender: newSender }, { text: '新窗口' })
    expect(held.has(8)).toBe(true)
    expect(held.size(8)).toBe(1)
  })
})

describe('voice:pickRefAudio', () => {
  const pick = () => handlers.get('pet:voice:pickRefAudio')!({})

  it('取消回 canceled', async () => {
    dialogResult = { canceled: true, filePaths: [] }
    await expect(pick()).resolves.toEqual({ ok: false, reason: 'canceled' })
  })

  it('选中回绝对路径', async () => {
    dialogResult = { canceled: false, filePaths: ['/tmp/voice.wav'] }
    await expect(pick()).resolves.toEqual({ ok: true, path: '/tmp/voice.wav' })
  })
})
