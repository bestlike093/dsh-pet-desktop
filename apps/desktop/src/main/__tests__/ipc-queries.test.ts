import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { registerQueryChannels, STATUS_TTL_MS, type QueryChannelDeps } from '../ipc/queries.js'
import { shortCircuit } from './helpers/short-circuit.js'

const recorded: Array<{ channel: string; listener: (...args: any[]) => unknown }> = []

let voiceSettings: Record<string, any> = {}
let ttsEndpoint = ''
let probeResult: Record<string, any> = { ok: true, status: 200 }
let probeCalls = 0
let toTtsCalls = 0
let nowValue = 0

function isLoopback(endpoint: string): boolean {
  try {
    const host = new URL(endpoint).hostname.replace(/^\[|\]$/g, '')
    return ['127.0.0.1', '::1', 'localhost'].includes(host)
  } catch {
    return false
  }
}

const deps: QueryChannelDeps = {
  registerChannel: (channel, listener) => recorded.push({ channel, listener }),
  getSettings: () => voiceSettings,
  getLastRenderInfo: () => null,
  modelStore: { list: async () => [], root: '', toMediaUrl: () => '' },
  packStore: { list: async () => [] },
  assetLibrary: { list: async () => ({ ok: true, groups: [], total: 0 }) },
  systemStats: { snapshot: () => ({}) },
  presenceService: { currentMood: () => ({}) },
  chatService: { history: () => [], status: () => ({}), test: async () => ({ ok: true }) },
  chatHistoryStore: { stats: () => ({ persisted: false }) },
  memoryStore: {
    stats: () => ({ available: false, count: 0 }),
    list: () => ({ items: [], total: 0 })
  },
  memoryEnabled: () => false,
  collectMemoryAll: () => [],
  requireSecretStore: () => ({ getMasked: async () => null }),
  getSecretStore: () => null,
  getVault: () => null,
  buildPersonaPrompt: () => ({}),
  getBackupPrefs: async () => ({ dir: '', keep: 1, lastRunAt: null }),
  fs: {
    readdir: async () => {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    },
    readFile: async () => '',
    stat: async () => null,
    statfs: async () => {
      throw new Error('unsupported')
    }
  },
  path: {
    join: (...parts: string[]) => parts.join('/'),
    basename: (value: string) => value
  },
  app: { getPath: () => '/documents' },
  userData: '/user',
  reportsDir: '/user/reports',
  balanceService: 'balance',
  balanceField: 'apiKey',
  syncSecretService: 'sync',
  syncSecretField: 'passphrase',
  defaultSettings: { voice: {} },
  probeTtsEndpoint: async () => {
    probeCalls += 1
    return probeResult
  },
  toTtsEndpoint: () => {
    toTtsCalls += 1
    return ttsEndpoint
  },
  isLoopbackEndpoint: isLoopback,
  now: () => nowValue,
  log: () => undefined
}

beforeAll(() => {
  registerQueryChannels(deps)
})

describe('registerQueryChannels', () => {
  it('查询通道名单固定，迁文件不增不减', () => {
    expect(recorded.map((item) => item.channel).sort()).toEqual(
      [
        'pet:assets:list',
        'pet:backup:getConfig',
        'pet:chat:history',
        'pet:chat:status',
        'pet:daily:last',
        'pet:llm:test',
        'pet:memory:list',
        'pet:memory:stats',
        'pet:models:active',
        'pet:models:list',
        'pet:packs:list',
        'pet:persona:preview',
        'pet:preflight',
        'pet:presence:mood',
        'pet:render:info',
        'pet:secrets:masked',
        'pet:settings:get',
        'pet:sync:passphraseStatus',
        'pet:system:stats',
        'pet:voice:status'
      ].sort()
    )
  })

  it('每个 channel 只注册一次', () => {
    const channels = recorded.map((item) => item.channel)
    expect(new Set(channels).size).toBe(channels.length)
  })

  it('pet:chat:status 全仓只注册一处', () => {
    expect(recorded.filter((item) => item.channel === 'pet:chat:status')).toHaveLength(1)
  })

  it('每个 channel 用空入参 invoke 一次都不抛', async () => {
    for (const { channel, listener } of recorded) {
      await expect(
        Promise.resolve().then(() => listener({}, {})),
        `${channel} 不应抛错`
      ).resolves.toBeDefined()
    }
  })
})

describe('voice:status', () => {
  const status = () => recorded.find((item) => item.channel === 'pet:voice:status')!.listener({}, {})

  beforeEach(() => {
    voiceSettings = { voice: {} }
    ttsEndpoint = ''
    probeResult = { ok: true, status: 200 }
    nowValue = 0
    probeCalls = 0
    toTtsCalls = 0
  })

  it('能力整体关闭时先回 disabled，不做地址判定', async () => {
    voiceSettings = { voice: { provider: 'off' } }
    ttsEndpoint = 'http://example.test/tts'
    await expect(status()).resolves.toEqual({ ok: true, state: 'disabled' })
    shortCircuit.toHoldFor('pet:voice:status', () => probeCalls)
    expect(toTtsCalls).toBe(0)
  })

  it('云端未填地址', async () => {
    voiceSettings = { voice: { provider: 'cloud', cloud: { baseUrl: '' } } }
    await expect(status()).resolves.toEqual({ ok: true, state: 'cloud-unconfigured' })
  })

  it('云端填了地址但未验证', async () => {
    voiceSettings = { voice: { provider: 'cloud', cloud: { baseUrl: 'https://example.test' } } }
    await expect(status()).resolves.toEqual({ ok: true, state: 'cloud-unverified' })
  })

  it('本地没填地址', async () => {
    voiceSettings = { voice: { provider: 'local' } }
    await expect(status()).resolves.toEqual({ ok: true, state: 'no-endpoint' })
  })

  it('本地没选参考音频', async () => {
    voiceSettings = { voice: { provider: 'local' } }
    ttsEndpoint = 'http://127.0.0.1:9880/tts'
    await expect(status()).resolves.toEqual({ ok: true, state: 'no-ref-audio' })
  })

  it('探测通过回 ready', async () => {
    voiceSettings = { voice: { provider: 'local', refAudioPath: '/ready.wav' } }
    ttsEndpoint = 'http://127.0.0.1:9880/tts'
    probeResult = { ok: true, status: 405 }
    await expect(status()).resolves.toEqual({ ok: true, state: 'ready', status: 405 })
  })

  it('非回环地址在探测前直接 not-loopback', async () => {
    voiceSettings = { voice: { provider: 'local', refAudioPath: '/loopback.wav' } }
    ttsEndpoint = 'http://example.test/tts'
    probeCalls = 0
    probeResult = { ok: true, status: 200 }
    await expect(status()).resolves.toEqual({ ok: true, state: 'not-loopback' })
    shortCircuit.toHoldFor('pet:voice:status', () => probeCalls)
  })

  it('自指地址端口非法时仍按 not-loopback 拒绝', async () => {
    voiceSettings = { voice: { provider: 'local', refAudioPath: '/bad-port.wav' } }
    ttsEndpoint = 'http://127.0.0.1:99999/tts'
    probeCalls = 0
    await expect(status()).resolves.toEqual({ ok: true, state: 'not-loopback' })
    shortCircuit.toHoldFor('pet:voice:status', () => probeCalls)
  })

  it('should short-circuit to no-endpoint before loopback check when address is empty', async () => {
    voiceSettings = { voice: { provider: 'local' } }
    ttsEndpoint = ''
    // 即便探测结果会是 not-loopback，也不该走到探测：空地址优先判未配置。
    probeResult = { ok: false, error: 'not-loopback' }
    await expect(status()).resolves.toEqual({ ok: true, state: 'no-endpoint' })
  })

  it('同 key 10 秒内命中缓存，不再探测', async () => {
    voiceSettings = { voice: { provider: 'local', refAudioPath: '/cached.wav' } }
    ttsEndpoint = 'http://127.0.0.1:9880/tts'
    probeResult = { ok: true, status: 200 }

    await expect(status()).resolves.toEqual({ ok: true, state: 'ready', status: 200 })

    // 第二次把探测结果改成失败；仍应命中缓存，证明没有重新探测。
    probeResult = { ok: false, error: 'timeout' }
    await expect(status()).resolves.toEqual({ ok: true, state: 'ready', status: 200 })
  })

  it('超过 STATUS_TTL_MS 必须重探测', async () => {
    voiceSettings = { voice: { provider: 'local', refAudioPath: '/expired.wav' } }
    ttsEndpoint = 'http://127.0.0.1:9880/tts'
    nowValue = 1_000_000
    probeResult = { ok: true, status: 200 }

    await expect(status()).resolves.toEqual({ ok: true, state: 'ready', status: 200 })

    // 跨过 TTL 后换成失败结果；必须重新探测并返回新状态。
    nowValue += STATUS_TTL_MS + 100
    probeResult = { ok: false, error: 'timeout' }
    await expect(status()).resolves.toEqual({ ok: true, state: 'offline', error: 'timeout' })
  })
})
