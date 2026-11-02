import { describe, expect, it } from 'vitest'
import { registerQueryChannels, type QueryChannelDeps } from '../ipc/queries.js'

const items = [
  { id: 'a', role: 'user', at: '2026-10-01T10:00:00.000Z', text: '喜欢粉色' },
  { id: 'b', role: 'assistant', at: '2026-10-15T10:00:00.000Z', text: '粉色是爱的底色' },
  { id: 'c', role: 'user', at: '2026-11-01T10:00:00.000Z', text: '今天有点累' },
  { id: 'd', role: 'user', at: '', text: '没有时间的条目' }
]

const listeners = new Map<string, (...args: any[]) => unknown>()

const deps = {
  registerChannel: (channel: string, listener: (...args: any[]) => unknown) => {
    listeners.set(channel, listener)
  },
  getSettings: () => ({}),
  getLastRenderInfo: () => null,
  modelStore: { list: async () => [], root: '', toMediaUrl: () => '' },
  packStore: { list: async () => [] },
  assetLibrary: { list: async () => ({ ok: true, groups: [], total: 0 }) },
  systemStats: { snapshot: () => ({}) },
  presenceService: { currentMood: () => ({}) },
  chatService: { history: () => [], status: () => ({}), test: async () => ({ ok: true }) },
  chatHistoryStore: { stats: () => ({ persisted: false }) },
  memoryStore: {
    stats: () => ({ available: true, count: items.length }),
    list: ({ offset = 0, limit = 50 }: { offset?: number; limit?: number } = {}) => ({
      items: items.slice(offset, offset + limit),
      total: items.length
    })
  },
  memoryEnabled: () => true,
  collectMemoryAll: () => items,
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
  path: { join: (...parts: string[]) => parts.join('/'), basename: (value: string) => value },
  app: { getPath: () => '/documents' },
  userData: '/user',
  reportsDir: '/user/reports',
  balanceService: 'balance',
  balanceField: 'apiKey',
  syncSecretService: 'sync',
  syncSecretField: 'passphrase',
  defaultSettings: { voice: {} },
  probeTtsEndpoint: async () => ({ ok: true }),
  toTtsEndpoint: () => '',
  isLoopbackEndpoint: () => true,
  now: () => 0,
  log: () => undefined
} as unknown as QueryChannelDeps

registerQueryChannels(deps)

async function list(payload: Record<string, unknown> = {}) {
  const handler = listeners.get('pet:memory:list')
  if (handler === undefined) throw new Error('pet:memory:list 未注册')
  return (await handler({}, payload)) as {
    ok: boolean
    total: number
    items: Array<{ id: string }>
  }
}

describe('pet:memory:list 筛选', () => {
  it('没有筛选时走分页存储', async () => {
    const result = await list()
    expect(result.ok).toBe(true)
    expect(result.total).toBe(4)
    expect(result.items.map((item) => item.id)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('按来源筛选，不因缺少时间被排除', async () => {
    const result = await list({ role: 'user' })
    expect(result.items.map((item) => item.id)).toEqual(['a', 'c', 'd'])
  })

  it('按日期范围筛选，纯日期包含结束当天', async () => {
    const result = await list({ from: '2026-10-01', to: '2026-10-15' })
    expect(result.items.map((item) => item.id)).toEqual(['a', 'b'])
  })

  it('时间筛选会排除时间未知的条目', async () => {
    const result = await list({ from: '2026-01-01' })
    expect(result.items.map((item) => item.id)).toEqual(['a', 'b', 'c'])
  })

  it('关键词、来源、时间可叠加', async () => {
    const result = await list({ query: '粉色', role: 'assistant', from: '2026-10-01', to: '2026-10-31' })
    expect(result.items.map((item) => item.id)).toEqual(['b'])
  })

  it('命中结果先过滤再分页', async () => {
    const result = await list({ role: 'user', offset: 1, limit: 1 })
    expect(result.total).toBe(3)
    expect(result.items.map((item) => item.id)).toEqual(['c'])
  })
})
