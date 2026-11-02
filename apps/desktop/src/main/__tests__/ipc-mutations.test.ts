import { beforeAll, describe, expect, it } from 'vitest'
import { registerMutationChannels, type MutationChannelDeps } from '../ipc/mutations.js'

const recorded: Array<{ channel: string; listener: (...args: any[]) => unknown }> = []

const deps: MutationChannelDeps = {
  registerChannel: (channel, listener) => recorded.push({ channel, listener }),
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
  sanitizeSettingsPatch: (raw) =>
    Object.fromEntries(Object.entries(raw).filter(([key]) => key === 'theme')),
  mergeLayer: (base, patch) => ({ ...base, ...patch }),
  settingsTopKeys: new Set(['theme']),
  writeJson: async () => undefined,
  applyIconSettings: () => undefined,
  broadcastSettings: () => undefined,
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
  path: {
    join: (...parts: string[]) => parts.join('/'),
    basename: (value: string) => value
  },
  log: () => undefined
}

beforeAll(() => {
  registerMutationChannels(deps)
})

describe('registerMutationChannels / 资产与备份域', () => {
  it('本域通道名单固定', () => {
    expect(recorded.map((item) => item.channel).sort()).toEqual(
      [
        'pet:backup:chooseDir',
        'pet:backup:run',
        'pet:backup:setKeep',
        'pet:packs:import',
        'pet:packs:remove',
        'pet:packs:setEnabled',
        'pet:settings:save',
        'pet:backup:probe'
      ].sort()
    )
  })

  it('每个 channel 只注册一次', () => {
    const channels = recorded.map((item) => item.channel)
    expect(new Set(channels).size).toBe(channels.length)
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
