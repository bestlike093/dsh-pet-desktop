import { describe, expect, it, vi } from 'vitest'
import { registerQueryChannels, type QueryChannelDeps } from '../queries.js'

type Handler = (event: unknown, payload?: unknown) => unknown

function harness(test = vi.fn(async () => ({ ok: true }))) {
  const handlers = new Map<string, Handler>()
  const deps = {
    registerChannel: (name: string, handler: (...args: any[]) => unknown) =>
      handlers.set(name, handler as Handler),
    getSettings: () => ({}),
    getLastRenderInfo: () => null,
    modelStore: { list: async () => [], root: '' },
    packStore: {},
    assetLibrary: {},
    systemStats: {},
    presenceService: {},
    chatService: {
      test,
      status: () => ({ enabled: false }),
      history: () => []
    },
    chatHistoryStore: { stats: () => ({ persisted: 0 }) },
    memoryStore: { stats: () => ({}) },
    memoryEnabled: () => false,
    collectMemoryAll: () => [],
    requireSecretStore: () => ({ getMasked: async () => null }),
    getSecretStore: () => null,
    getVault: () => null,
    buildPersonaPrompt: () => ({}),
    getBackupPrefs: async () => ({}),
    fs: {},
    path: { join: (...parts: string[]) => parts.join('/') },
    app: { getPath: () => '' },
    userData: '',
    reportsDir: '',
    balanceService: 'x',
    balanceField: 'y',
    syncSecretService: 'x',
    syncSecretField: 'y',
    defaultSettings: { voice: {} },
    probeTtsEndpoint: async () => ({}),
    toTtsEndpoint: () => '',
    isLoopbackEndpoint: () => false,
    now: () => 0,
    log: () => {}
  } as unknown as QueryChannelDeps

  registerQueryChannels(deps)
  return { handlers, test }
}

describe('pet:llm:test 通道', () => {
  it('原样返回 chatService.test 的结果，且只调一次', async () => {
    const test = vi.fn(async () => ({ ok: true, model: 'deepseek-chat', ms: 12 }))
    const { handlers } = harness(test)
    const handler = handlers.get('pet:llm:test')!

    expect(handler).toBeTypeOf('function')
    await expect(handler(null)).resolves.toEqual({ ok: true, model: 'deepseek-chat', ms: 12 })
    expect(test).toHaveBeenCalledTimes(1)
  })

  it('失败结果原样透传，不把 ok:false 改写成异常', async () => {
    const test = vi.fn(async () => ({ ok: false, reason: 'unauthorized' }))
    const { handlers } = harness(test)

    await expect(handlers.get('pet:llm:test')!(null)).resolves.toEqual({
      ok: false,
      reason: 'unauthorized'
    })
  })
})
