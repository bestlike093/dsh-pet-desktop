import { beforeEach, describe, expect, it } from 'vitest'
import { registerMutationChannels, type MutationChannelDeps } from '../ipc/mutations.js'
import { registerQueryChannels, type QueryChannelDeps } from '../ipc/queries.js'

let settings: Record<string, any> = {}
let broadcasts: Array<Record<string, any>> = []
let writes: Array<Record<string, any>> = []
let events: Array<{ type: 'write' | 'broadcast'; value: Record<string, any> }> = []
let iconRefreshCount = 0

const handlers = new Map<string, (...args: any[]) => unknown>()
const register = (channel: string, listener: (...args: any[]) => unknown) => {
  handlers.set(channel, listener)
}

const queryDeps: QueryChannelDeps = {
  registerChannel: register,
  getSettings: () => settings,
  getLastRenderInfo: () => null,
  modelStore: { list: async () => [], root: '', toMediaUrl: () => '' },
  packStore: { list: async () => [] },
  stickerInbox: { list: async () => [] },
  stickerLibrary: { list: async () => [] },
  assetLibrary: { list: async () => ({ ok: true, groups: [], total: 0 }) },
  systemStats: { snapshot: () => ({}) },
  presenceService: { currentMood: () => ({}) },
  chatService: { history: () => [], status: () => ({}) },
  chatHistoryStore: { stats: () => ({ persisted: false }) },
  memoryStore: { stats: () => ({ available: false, count: 0 }), list: () => ({ items: [], total: 0 }) },
  memoryEnabled: () => false,
  collectMemoryAll: () => [],
  requireSecretStore: () => ({ getMasked: async () => null }),
  getSecretStore: () => null,
  getVault: () => null,
  buildPersonaPrompt: () => ({}),
  getBackupPrefs: async () => ({ dir: '', keep: 3, lastRunAt: null }),
  fs: {
    readdir: async () => [],
    readFile: async () => '',
    stat: async () => null,
    statfs: async () => ({ bavail: 1, bsize: 1 })
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
  now: () => Date.now(),
  log: () => undefined
}

const mutationDeps: MutationChannelDeps = {
  registerChannel: register,
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  getDialogParent: () => undefined,
  stickerInbox: {
    list: async () => [],
    approve: async () => ({ ok: true }),
    reject: async () => ({ ok: true })
  },
  openStickerWindow: () => undefined,
  sendQqSticker: async () => ({ ok: true }),
  packStore: {
    importFromZip: async () => ({ id: 'pack-1' }),
    list: async () => [],
    setEnabled: async () => ({}),
    remove: async () => undefined
  },
  getSettings: () => settings,
  setSettings: (next) => {
    settings = next
  },
  settingsPath: '/settings.json',
  sanitizeSettingsPatch: (raw) =>
    Object.fromEntries(Object.entries(raw).filter(([key]) => ['theme', 'companion'].includes(key))),
  mergeLayer: (base, patch) => ({ ...base, ...patch }),
  settingsTopKeys: new Set(['theme', 'companion']),
  writeJson: async (_file, value) => {
    const next = value as Record<string, any>
    writes.push(next)
    events.push({ type: 'write', value: next })
  },
  applyIconSettings: () => {
    iconRefreshCount += 1
  },
  broadcastSettings: (next) => {
    broadcasts.push(next)
    events.push({ type: 'broadcast', value: next })
  },
  getBackupPrefs: async () => ({ dir: '', keep: 3, lastRunAt: null }),
  saveBackupPrefs: async () => undefined,
  getAppPath: () => '/documents',
  getVault: () => null,
  createVaultBackup: async () => ({ files: [] }),
  readBackupFiles: async () => [],
  restrictPermissions: async () => undefined,
  fs: {
    access: async () => {
      throw new Error('missing')
    },
    stat: async () => ({ isDirectory: () => true, mtimeMs: 0 }),
    readdir: async () => [],
    rm: async () => undefined,
    writeFile: async () => undefined
  },
  path: { join: (...parts: string[]) => parts.join('/'), basename: (value: string) => value },
  log: () => undefined
}

beforeEach(() => {
  settings = { theme: 'light', companion: { chat: { provider: 'deepseek' } } }
  broadcasts = []
  writes = []
  events = []
  iconRefreshCount = 0
  handlers.clear()
  registerQueryChannels(queryDeps)
  registerMutationChannels(mutationDeps)
})

describe('设置域读写闭环', () => {
  it('save 之后 get 能读到同一个值，广播与落盘都到齐', async () => {
    const save = handlers.get('pet:settings:save')
    const get = handlers.get('pet:settings:get')
    expect(save).toBeDefined()
    expect(get).toBeDefined()

    const saved = (await save!({}, { theme: 'dark' })) as Record<string, any>
    expect(saved.theme).toBe('dark')

    const readBack = (await get!({}, {})) as Record<string, any>
    expect(readBack.theme).toBe('dark')

    expect(writes).toHaveLength(1)
    expect(writes[0]?.theme).toBe('dark')
    expect(broadcasts).toHaveLength(1)
    expect(broadcasts[0]?.theme).toBe('dark')
    expect(iconRefreshCount).toBe(1)

    // 顺序锁死：先落盘，再广播；广播 payload 必须就是落盘后的形态。
    // toBe 证的是「没有二次加工、没有换对象」，不证 immutable；
    // 若将来改成深拷贝，这里必须显式说明，不能把 toBe 降成 toEqual 把断言废掉。
    expect(events.map((event) => event.type)).toEqual(['write', 'broadcast'])
    const persisted = events[0]?.value
    const broadcasted = events[1]?.value
    expect(broadcasted).toBe(persisted)
    expect(readBack).toBe(persisted)
  })

  it('未登记字段只丢弃，不打断保存', async () => {
    const save = handlers.get('pet:settings:save')
    const saved = (await save!({}, { theme: 'dark', unknownField: 1 })) as Record<string, any>
    expect(saved.theme).toBe('dark')
    expect(saved.unknownField).toBeUndefined()
    expect(writes[0]?.theme).toBe('dark')
  })
})
