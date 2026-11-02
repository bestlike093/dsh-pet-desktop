import { beforeEach, describe, expect, it } from 'vitest'
import { registerMutationChannels, type MutationChannelDeps } from '../ipc/mutations.js'
import { registerQueryChannels, type QueryChannelDeps } from '../ipc/queries.js'

let prefs: { dir: string; keep: number; lastRunAt: string | null } = {
  dir: '/backups',
  keep: 3,
  lastRunAt: null
}
let releaseBackup: (() => void) | null = null
let backupCalls = 0
let writeCount = 0
let failNext = false
let started: Promise<void> = Promise.resolve()
let markStarted: () => void = () => {}

const handlers = new Map<string, (...args: any[]) => unknown>()
const register = (channel: string, listener: (...args: any[]) => unknown) => {
  handlers.set(channel, listener)
}

const queryDeps: QueryChannelDeps = {
  registerChannel: register,
  getSettings: () => ({}),
  getLastRenderInfo: () => null,
  modelStore: { list: async () => [], root: '', toMediaUrl: () => '' },
  packStore: { list: async () => [] },
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
  getBackupPrefs: async () => ({ ...prefs }),
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
  packStore: {
    importFromZip: async () => ({ id: 'pack-1' }),
    list: async () => [],
    setEnabled: async () => ({}),
    remove: async () => undefined
  },
  getSettings: () => ({}),
  setSettings: () => undefined,
  settingsPath: '/settings.json',
  sanitizeSettingsPatch: (raw) => raw,
  mergeLayer: (base, patch) => ({ ...base, ...patch }),
  settingsTopKeys: new Set(),
  writeJson: async () => undefined,
  applyIconSettings: () => undefined,
  broadcastSettings: () => undefined,
  getBackupPrefs: async () => ({ ...prefs }),
  saveBackupPrefs: async (patch) => {
    prefs = { ...prefs, ...(patch as Partial<typeof prefs>) }
  },
  getAppPath: () => '/documents',
  getVault: () => ({ ring: {} }),
  createVaultBackup: async () => {
    backupCalls += 1
    if (failNext) {
      failNext = false
      throw new Error('renderer-gone')
    }
    await new Promise<void>((resolve) => {
      releaseBackup = resolve
      markStarted()
    })
    return { files: [{}] }
  },
  readBackupFiles: async () => [],
  restrictPermissions: async () => undefined,
  fs: {
    access: async () => {
      throw new Error('missing')
    },
    stat: async () => ({ isDirectory: () => true, mtimeMs: 0 }),
    readdir: async () => [],
    rm: async () => undefined,
    writeFile: async () => {
      writeCount += 1
    }
  },
  path: { join: (...parts: string[]) => parts.join('/'), basename: (value: string) => value },
  log: () => undefined
}

beforeEach(() => {
  prefs = { dir: '/backups', keep: 3, lastRunAt: null }
  releaseBackup = null
  backupCalls = 0
  writeCount = 0
  failNext = false
  started = new Promise((resolve) => {
    markStarted = resolve
  })
  handlers.clear()
  registerQueryChannels(queryDeps)
  registerMutationChannels(mutationDeps)
})

describe('备份并发与中间态', () => {
  const probeLock = async () => {
    const probe = handlers.get('pet:backup:probe')
    expect(probe).toBeDefined()
    return (await probe!({}, {})) as { ok: boolean; inFlight: boolean }
  }

  it('短时双 invoke 第二次直接拒掉，不产出第二份包', async () => {
    const run = handlers.get('pet:backup:run')
    expect(run).toBeDefined()

    const first = run!({}, { password: '12345678' })
    await started
    expect((await probeLock()).inFlight).toBe(true)

    const second = await run!({}, { password: '12345678' })
    expect(second).toEqual({ ok: false, reason: 'busy' })
    expect((await probeLock()).inFlight).toBe(true)

    releaseBackup?.()
    const firstResult = (await first) as Record<string, unknown>
    expect(firstResult.ok).toBe(true)
    // await first 恢复时 finally 已经同步跑完，这里直接读即可，不需要 sleep。
    expect((await probeLock()).inFlight).toBe(false)
    expect(backupCalls).toBe(1)
    expect(writeCount).toBe(1)
  })

  it('备份进行中 getConfig 仍读到旧 lastRunAt，完成后才更新', async () => {
    const run = handlers.get('pet:backup:run')
    const getConfig = handlers.get('pet:backup:getConfig')
    expect(getConfig).toBeDefined()

    const first = run!({}, { password: '12345678' })
    await started

    const during = (await getConfig!({}, {})) as Record<string, unknown>
    expect(during.lastRunAt).toBe(null)

    releaseBackup?.()
    await first

    const after = (await getConfig!({}, {})) as Record<string, unknown>
    expect(typeof after.lastRunAt).toBe('string')
  })

  it('第一次失败（等效渲染进程中途断开）后锁释放，第二次仍能执行', async () => {
    const run = handlers.get('pet:backup:run')
    failNext = true

    const first = (await run!({}, { password: '12345678' })) as Record<string, unknown>
    expect(first).toMatchObject({ ok: false })
    expect((await probeLock()).inFlight).toBe(false)

    // 锁跟随主进程任务，不跟随发起窗口；失败也必须落回可再次进入的状态。
    const second = run!({}, { password: '12345678' })
    await started
    releaseBackup?.()

    await expect(second).resolves.toMatchObject({ ok: true })
    expect(backupCalls).toBe(2)
    expect((await probeLock()).inFlight).toBe(false)
  })
})
