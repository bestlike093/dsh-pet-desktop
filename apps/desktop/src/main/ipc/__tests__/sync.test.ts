import { describe, expect, it, vi } from 'vitest'
import { registerSyncChannels } from '../sync.js'

type Handler = (event: unknown, payload?: unknown) => Promise<Record<string, any>>

function harness(overrides: Record<string, any> = {}) {
  const handlers = new Map<string, Handler>()
  const deps = {
    registerChannel: (name: string, handler: Handler) => handlers.set(name, handler),
    dialog: {
      showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] }))
    },
    getSettingsSync: () => null,
    initSettingsSync: vi.fn(async () => undefined),
    getSyncPrefs: vi.fn(async () => ({ lastExportAt: null, lastPullAt: null })),
    saveSyncPrefs: vi.fn(async () => undefined),
    requireSecretStore: () => ({
      set: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined)
    }),
    syncSecretService: 'dsh-pet-sync',
    syncSecretField: 'passphrase',
    minPassphraseLength: 8,
    log: vi.fn(),
    ...overrides
  }
  registerSyncChannels(deps as any)
  return { handlers, deps }
}

/** 口令硬契约：7 / 8 位、含空格、全角、尾换行五个边界。 */
describe('同步口令校验', () => {
  const cases = [
    {
      name: '7 位拒绝',
      input: '1234567',
      ok: false,
      stored: null
    },
    {
      name: '8 位通过',
      input: '12345678',
      ok: true,
      stored: '12345678'
    },
    {
      name: '两端空格在计数前裁掉',
      input: '  pass  word  ',
      ok: true,
      stored: 'pass  word'
    },
    {
      name: '8 个全角字符按字符数通过',
      input: '口令口令口令口令',
      ok: true,
      stored: '口令口令口令口令'
    },
    {
      name: '粘贴带尾换行时先 trim',
      input: '12345678\n',
      ok: true,
      stored: '12345678'
    }
  ]

  for (const item of cases) {
    it(item.name, async () => {
      const store = {
        set: vi.fn(async () => undefined),
        clear: vi.fn(async () => undefined)
      }
      const { handlers } = harness({ requireSecretStore: () => store })

      // 拒绝用返回值表达，不抛错：渲染侧靠 reason 写提示。
      const result = await handlers.get('pet:sync:setPassphrase')!(null, {
        passphrase: item.input
      })

      if (item.ok) {
        expect(result).toEqual({ ok: true })
        expect(store.set).toHaveBeenCalledWith('dsh-pet-sync', item.stored, 'passphrase')
      } else {
        expect(result).toEqual({ ok: false, reason: 'passphrase-too-short' })
        expect(store.set).not.toHaveBeenCalled()
      }
    })
  }

  it('加密仓库不可用时回 vault-unavailable，而不是抛出', async () => {
    const store = {
      set: vi.fn(async () => {
        throw new Error('no backend')
      }),
      clear: vi.fn(async () => undefined)
    }
    const { handlers } = harness({ requireSecretStore: () => store })

    const result = await handlers.get('pet:sync:setPassphrase')!(null, {
      passphrase: '12345678'
    })
    expect(result).toEqual({ ok: false, reason: 'vault-unavailable' })
  })
})
