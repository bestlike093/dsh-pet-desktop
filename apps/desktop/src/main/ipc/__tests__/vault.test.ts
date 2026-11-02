import { describe, expect, it, vi } from 'vitest'
import { registerVaultChannels } from '../vault.js'

type Handler = (event: unknown, payload?: unknown) => Promise<Record<string, any>>

/** 用假依赖跑一遍注册，拿到 handler 并记录副作用调用顺序。 */
function harness(overrides: Record<string, any> = {}) {
  const handlers = new Map<string, Handler>()
  const calls: string[] = []
  const record = (name: string) => async (..._args: unknown[]) => {
    calls.push(name)
  }

  const deps = {
    registerChannel: (name: string, handler: Handler) => handlers.set(name, handler),
    getVault: () => ({ backend: { kind: 'file' }, ring: { kind: 'ring' } }),
    getVaultClient: () => ({
      rotate: vi.fn(async () => ({ from: 1, to: 2 }))
    }),
    getVaultBackend: () => ({ kind: 'file' }),
    getLegacyKeyMigrationWarning: () => null,
    cryptoSuite: 'AES-GCM',
    showOpenDialog: vi.fn(async () => ({ canceled: false, filePaths: ['C:/tmp/a.petbackup'] })),
    showSaveDialog: vi.fn(async () => ({ canceled: false, filePath: 'C:/tmp/out.petbackup' })),
    getDocumentsPath: () => 'C:/Documents',
    pathBasename: (file: string) => file.split('/').pop() ?? file,
    createVaultBackup: vi.fn(async () => ({
      version: 1,
      files: [{ name: 'settings.json' }],
      sealed: { ciphertext: 'fixed' }
    })),
    readBackupFiles: vi.fn(async () => [{ name: 'settings.json', data: new Uint8Array([1]) }]),
    fs: {
      readFile: vi.fn(async () => '{}'),
      writeFile: vi.fn(async (..._args: unknown[]) => {
        calls.push('writeFile')
      }),
      mkdir: record('mkdir'),
      copyFile: record('copyFile')
    },
    pathJoin: (...parts: string[]) => parts.join('/'),
    userData: 'C:/userData',
    vaultKeysPath: 'C:/userData/vault-keys.json',
    backupFiles: ['settings.json', 'memory.json'] as const,
    writeRestoredKeyRing: vi.fn(async () => {
      calls.push('writeRestoredKeyRing')
    }),
    openVaultBackup: vi.fn(async () => ({
      keys: [{ keyId: 1, epoch: 1 }],
      files: [{ name: 'settings.json', data: '{"a":1}' }]
    })),
    restrictPermissions: vi.fn(async () => {
      calls.push('restrictPermissions')
    }),
    disableMemory: vi.fn(() => calls.push('disableMemory')),
    disableChatHistory: vi.fn(() => calls.push('disableChatHistory')),
    markMemoryFlushed: vi.fn(() => calls.push('markMemoryFlushed')),
    scheduleRestart: vi.fn(() => calls.push('scheduleRestart')),
    describeError: (error: unknown) => (error instanceof Error ? error.message : String(error)),
    log: vi.fn(),
    ...overrides
  }

  registerVaultChannels(deps as any)
  return { handlers, deps, calls }
}

describe('vault 写通道', () => {
  it('rotate 成功只回 from/to，并记一条日志', async () => {
    const { handlers, deps } = harness()
    const result = await handlers.get('pet:vault:rotate')!(null)

    expect(result).toEqual({ ok: true, from: 1, to: 2 })
    expect(deps.log).toHaveBeenCalledWith('[vault] 已轮换密钥', 'epoch=1->2')
  })

  it('rotate 失败不误报成功，也不触碰导入/重启副作用', async () => {
    const failure = new Error('disk full')
    const { handlers, deps, calls } = harness({
      getVaultClient: () => ({
        rotate: vi.fn(async () => {
          throw failure
        })
      })
    })

    const result = await handlers.get('pet:vault:rotate')!(null)

    expect(result).toEqual({ ok: false, reason: 'failed', message: 'disk full' })
    expect(calls).toEqual([])
    expect(deps.disableMemory).not.toHaveBeenCalled()
    expect(deps.scheduleRestart).not.toHaveBeenCalled()
  })

  it('diagnose 成功：把 vault 自检与迁移告警合并返回', async () => {
    const { handlers } = harness({
      getVault: () => ({
        backend: { kind: 'file' },
        ring: { kind: 'ring' },
        diagnose: vi.fn(async () => ({ keys: 2, acl: 'ok' }))
      }),
      getLegacyKeyMigrationWarning: () => ({ code: 'LEGACY_KEY' })
    })

    const result = await handlers.get('pet:vault:diagnose')!(null)

    expect(result).toEqual({
      ok: true,
      keys: 2,
      acl: 'ok',
      legacyKeyMigration: { code: 'LEGACY_KEY' }
    })
  })

  it('diagnose 在 vault 未装配时返回 VAULT_UNAVAILABLE', async () => {
    const { handlers } = harness({ getVault: () => null })

    const result = await handlers.get('pet:vault:diagnose')!(null)

    expect(result).toEqual({
      ok: false,
      code: 'VAULT_UNAVAILABLE',
      message: '加密仓库没有装配成功'
    })
  })

  it('export 成功：写入内容与老路径的 JSON.stringify 逐字节一致', async () => {
    const backup = { version: 1, files: [{ name: 'settings.json' }], sealed: { ciphertext: 'fixed' } }
    const writeFile = vi.fn(async (_file: string, _data: string) => undefined)
    const { handlers, deps } = harness({
      createVaultBackup: vi.fn(async () => backup),
      fs: {
        readFile: vi.fn(async () => '{}'),
        writeFile,
        mkdir: vi.fn(async () => undefined),
        copyFile: vi.fn(async () => undefined)
      }
    })

    const result = await handlers.get('pet:vault:export')!(null, { password: 'a-good-password' })

    expect(result).toEqual({ ok: true, fileName: 'out.petbackup', fileCount: 1 })
    expect(deps.createVaultBackup).toHaveBeenCalledWith({
      ring: { kind: 'ring' },
      password: 'a-good-password',
      files: [{ name: 'settings.json', data: new Uint8Array([1]) }]
    })
    expect(writeFile).toHaveBeenCalledTimes(1)
    expect(writeFile.mock.calls[0]?.[1]).toBe(JSON.stringify(backup))
    expect(deps.restrictPermissions).toHaveBeenCalledWith('C:/tmp/out.petbackup')
    expect(deps.log).toHaveBeenCalledWith('[backup] 已导出', 'files=1')
  })

  it('export 取消：不生成备份、不写盘', async () => {
    const { handlers, deps } = harness({
      showSaveDialog: vi.fn(async () => ({ canceled: true }))
    })

    const result = await handlers.get('pet:vault:export')!(null, { password: 'a-good-password' })

    expect(result).toEqual({ ok: false, reason: 'canceled' })
    expect(deps.createVaultBackup).not.toHaveBeenCalled()
    expect(deps.fs.writeFile).not.toHaveBeenCalled()
    expect(deps.restrictPermissions).not.toHaveBeenCalled()
  })

  it('export 失败：不写半截文件，也不限权', async () => {
    const { handlers, deps } = harness({
      createVaultBackup: vi.fn(async () => {
        throw new Error('wrap failed')
      })
    })

    const result = await handlers.get('pet:vault:export')!(null, { password: 'a-good-password' })

    expect(result).toEqual({ ok: false, reason: 'failed', message: 'wrap failed' })
    expect(deps.fs.writeFile).not.toHaveBeenCalled()
    expect(deps.restrictPermissions).not.toHaveBeenCalled()
  })

  it('export 口令不足 8 位时直接拒绝，不弹保存框', async () => {
    const { handlers, deps } = harness()
    const result = await handlers.get('pet:vault:export')!(null, { password: '1234567' })

    expect(result).toEqual({ ok: false, reason: 'weak-password', message: '备份口令至少 8 位' })
    expect(deps.showSaveDialog).not.toHaveBeenCalled()
  })

  it('口令不足 8 位时直接拒绝，不弹文件框', async () => {
    const { handlers, deps } = harness()
    const result = await handlers.get('pet:vault:import')!(null, { password: '1234567' })

    expect(result).toEqual({ ok: false, reason: 'weak-password', message: '备份口令至少 8 位' })
    expect(deps.showOpenDialog).not.toHaveBeenCalled()
  })

  it('拒绝被篡改 / 版本不符的包：解包失败即返回，不写盘不重启', async () => {
    const { handlers, deps, calls } = harness({
      openVaultBackup: vi.fn(async () => {
        throw new Error('VAULT_TAMPERED')
      })
    })

    const result = await handlers.get('pet:vault:import')!(null, { password: '12345678' })

    expect(result).toEqual({
      ok: false,
      reason: 'invalid-backup',
      message: 'VAULT_TAMPERED'
    })
    expect(calls).toEqual([])
    expect(deps.writeRestoredKeyRing).not.toHaveBeenCalled()
    expect(deps.scheduleRestart).not.toHaveBeenCalled()
  })

  it('写盘中途失败时保留回滚目录，不进入停写与重启', async () => {
    const { handlers, deps, calls } = harness({
      writeRestoredKeyRing: vi.fn(async () => {
        throw new Error('EACCES')
      })
    })

    const result = await handlers.get('pet:vault:import')!(null, { password: '12345678' })

    expect(result.ok).toBe(false)
    expect(result.reason).toBe('failed')
    expect(result.message).toBe('EACCES')
    expect(String(result.rollbackDir)).toContain('import-rollback-')
    // 快照已经建好，失败点之后不再有副作用。
    expect(calls).toEqual(['mkdir', 'copyFile', 'copyFile'])
    expect(deps.disableMemory).not.toHaveBeenCalled()
    expect(deps.scheduleRestart).not.toHaveBeenCalled()
  })

  it('导入成功的副作用顺序固定：写环 → 写文件 → 收权限 → 停写 → 重启', async () => {
    const { handlers, calls } = harness()
    const result = await handlers.get('pet:vault:import')!(null, { password: '12345678' })

    expect(result).toMatchObject({ ok: true, restartRequired: true, fileCount: 1 })
    expect(calls).toEqual([
      'mkdir',
      'copyFile',
      'copyFile',
      'writeRestoredKeyRing',
      'writeFile',
      'restrictPermissions',
      'disableMemory',
      'disableChatHistory',
      'markMemoryFlushed',
      'scheduleRestart'
    ])
  })
})
