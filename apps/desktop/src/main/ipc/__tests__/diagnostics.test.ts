import { describe, expect, it } from 'vitest'
import { registerDiagnosticsChannels, type DiagnosticsDeps } from '../diagnostics.js'

type Handler = (event: unknown, payload?: unknown) => unknown

function harness(overrides: Partial<DiagnosticsDeps> = {}) {
  const handlers = new Map<string, Handler>()
  const deps: DiagnosticsDeps = {
    registerChannel: (name, handler) => handlers.set(name, handler as Handler),
    getAppVersion: () => '0.1.0',
    listIpcChannels: () => ['pet:a', 'pet:b'],
    getRegisteredChannels: () => ['pet:a', 'pet:b'],
    getPendingDecisionIds: () => ['decision-1'],
    getSettings: () => ({ live2dModelId: 'model-1' }),
    getMediaRoot: () => 'C:/models',
    modelStore: { list: async () => [{ id: 'model-1' }] },
    getQq: () => ({ health: async () => ({ ok: true, state: 'ready' }) }),
    getVault: () => ({ diagnose: async () => ({ backend: 'file' }) }),
    getLegacyKeyMigrationWarning: () => null,
    ...overrides
  }

  registerDiagnosticsChannels(deps)
  return handlers
}

describe('pet:diagnostics:collect 通道', () => {
  it('汇总只读诊断快照，不透传密钥或写盘', async () => {
    const handlers = harness()
    const result = (await handlers.get('pet:diagnostics:collect')!(null)) as Record<string, any>

    expect(result.app.version).toBe('0.1.0')
    expect('electron' in result.app).toBe(true)
    expect(typeof result.app.node).toBe('string')
    expect(result.platform).toBe(process.platform)
    expect(result.ipcChannels).toEqual({
      listed: ['pet:a', 'pet:b'],
      registered: ['pet:a', 'pet:b']
    })
    expect(result.pendingDecisions).toEqual(['decision-1'])
    expect(result.channels).toEqual({ local: { ok: true }, qq: { ok: true, state: 'ready' } })
    expect(result.media).toEqual({
      root: 'C:/models',
      activeId: 'model-1',
      models: [{ id: 'model-1' }]
    })
    expect(result.vault).toEqual({ ok: true, backend: 'file', legacyKeyMigration: null })
  })

  it('QQ 未配置与 vault 不可用时给出明确状态码', async () => {
    const warning = { code: 'LEGACY_KEY_NOT_MIGRATED', message: '旧密钥未迁移' }
    const handlers = harness({
      getQq: () => null,
      getVault: () => null,
      getLegacyKeyMigrationWarning: () => warning
    })

    const result = (await handlers.get('pet:diagnostics:collect')!(null)) as Record<string, any>

    expect(result.channels.qq).toEqual({
      ok: false,
      code: 'CHANNEL_NOT_CONFIGURED',
      message: 'QQ 凭据未配置'
    })
    expect(result.vault).toEqual({
      ok: false,
      code: 'VAULT_UNAVAILABLE',
      legacyKeyMigration: warning
    })
  })

  it('模型列表读取失败时回空数组，不拖垮整张诊断', async () => {
    const handlers = harness({
      modelStore: {
        list: async () => {
          throw new Error('disk exploded')
        }
      }
    })

    const result = (await handlers.get('pet:diagnostics:collect')!(null)) as Record<string, any>

    expect(result.media.models).toEqual([])
    expect(result.app.version).toBe('0.1.0')
  })
})
