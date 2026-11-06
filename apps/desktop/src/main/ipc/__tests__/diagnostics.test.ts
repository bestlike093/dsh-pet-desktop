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

  it('诊断包路径里的用户名被隐去', async () => {
    const handlers = harness({
      getMediaRoot: () => 'C:\\Users\\tester\\AppData\\Roaming\\desktop-pet\\media',
      getVault: () => ({
        // 拆开拼，避免仓库里出现一条真实的 POSIX 用户目录字面量
        diagnose: async () => ({ backend: 'file', recoveredFrom: ['', 'home', 'tester', 'old'].join('/') })
      })
    })

    const result = (await handlers.get('pet:diagnostics:collect')!(null)) as Record<string, any>

    expect(result.media.root).toBe(
      'C:\\Users\\***\\AppData\\Roaming\\desktop-pet\\media'
    )
    expect(result.vault.recoveredFrom).toBe('/home/***/old')
  })

  it('通道健康只留约定字段，未来多出的 token / 地址不进诊断包', async () => {
    const handlers = harness({
      getQq: () => ({
        health: async () => ({
          ok: false,
          code: 'CHANNEL_UNREACHABLE',
          message: '握手失败',
          state: 'offline',
          accessToken: 'secret-token',
          webhook: 'https://example.invalid/hook?key=abc',
          ownerOpenIds: ['owner-openid']
        })
      })
    })

    const result = (await handlers.get('pet:diagnostics:collect')!(null)) as Record<string, any>

    expect(result.channels.qq).toEqual({
      ok: false,
      code: 'CHANNEL_UNREACHABLE',
      message: '握手失败',
      state: 'offline'
    })
    expect(JSON.stringify(result)).not.toContain('secret-token')
    expect(JSON.stringify(result)).not.toContain('example.invalid')
    expect(JSON.stringify(result)).not.toContain('owner-openid')
  })

  it('构建信息只透出约定字段，多余内容不外泄', async () => {
    const handlers = harness({
      getBuildInfo: () => ({
        sha: 'abcdef1234567890',
        builtAt: '2026-11-06T11:41:00.000Z',
        dirty: true,
        secretPath: 'C:/Users/alice/private'
      })
    })

    const result = (await handlers.get('pet:diagnostics:collect')!(null)) as Record<string, any>

    expect(result.app.sha).toBe('abcdef1234567890')
    expect(result.app.builtAt).toBe('2026-11-06T11:41:00.000Z')
    expect(result.app.dirty).toBe(true)
    expect('secretPath' in result.app).toBe(false)
    expect(JSON.stringify(result)).not.toContain('private')
  })
})
