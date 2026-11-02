import { describe, expect, it, vi } from 'vitest'
import { registerBackupChannels } from '../backup.js'

type Handler = (event: unknown, payload?: unknown) => Promise<Record<string, any>>

type Entry = { isFile: () => boolean; name: string }

/** 用假目录跑一遍注册，只关心枚举结果与容错。 */
function harness(overrides: Record<string, any> = {}) {
  const handlers = new Map<string, Handler>()
  const deps = {
    registerChannel: (name: string, handler: Handler) => handlers.set(name, handler),
    getBackupPrefs: vi.fn(async () => ({ dir: '' })),
    getDocumentsPath: () => 'C:/Documents',
    pathJoin: (...parts: string[]) => parts.join('/'),
    pathBasename: (file: string) => file.split('/').pop() ?? file,
    saveBackupPrefs: vi.fn(async () => undefined),
    readAutoPassword: vi.fn(async () => ''),
    writeAutoPassword: vi.fn(async () => true),
    removeAutoSecret: vi.fn(async () => undefined),
    fs: {
      readdir: vi.fn(async () => [] as Entry[]),
      stat: vi.fn(async () => ({ mtimeMs: 0 }))
    },
    ...overrides
  }

  registerBackupChannels(deps as any)
  return { handlers, deps }
}

const file = (name: string): Entry => ({ isFile: () => true, name })
const dir = (name: string): Entry => ({ isFile: () => false, name })

describe('备份通道', () => {
  it('未设置目录时从文档目录找最新的 .petbackup', async () => {
    const { handlers, deps } = harness({
      fs: {
        readdir: vi.fn(async () => [
          file('dsh-pet-2026-10-01.petbackup'),
          dir('dsh-pet-dir.petbackup'),
          file('notes.txt'),
          file('dsh-pet-2026-11-02.petbackup')
        ]),
        stat: vi.fn(async (full: string) => ({
          mtimeMs: full.endsWith('2026-11-02.petbackup') ? 200 : 100
        }))
      }
    })

    const result = await handlers.get('pet:backup:findLatest')!(null)

    expect(deps.getBackupPrefs).toHaveBeenCalledTimes(1)
    expect(result).toEqual({
      ok: true,
      found: true,
      dir: 'C:/Documents',
      path: 'C:/Documents/dsh-pet-2026-11-02.petbackup',
      fileName: 'dsh-pet-2026-11-02.petbackup',
      mtime: new Date(200).toISOString()
    })
  })

  it('设置了目录就只用该目录', async () => {
    const { handlers, deps } = harness({
      getBackupPrefs: vi.fn(async () => ({ dir: 'D:/Backups' })),
      fs: {
        readdir: vi.fn(async () => [file('dsh-pet-a.petbackup')]),
        stat: vi.fn(async () => ({ mtimeMs: 1 }))
      }
    })

    const result = await handlers.get('pet:backup:findLatest')!(null)

    expect(deps.fs.readdir).toHaveBeenCalledWith('D:/Backups', { withFileTypes: true })
    expect(result.path).toBe('D:/Backups/dsh-pet-a.petbackup')
    expect(result.dir).toBe('D:/Backups')
  })

  it('没有匹配文件时返回 found=false，不报错', async () => {
    const { handlers } = harness()

    const result = await handlers.get('pet:backup:findLatest')!(null)

    expect(result).toEqual({
      ok: true,
      found: false,
      dir: 'C:/Documents',
      path: '',
      fileName: '',
      mtime: ''
    })
  })

  it('目录不可读或单文件 stat 失败时跳过，不中断枚举', async () => {
    const unreadable = harness({
      fs: {
        readdir: vi.fn(async () => {
          throw new Error('ENOENT')
        }),
        stat: vi.fn(async () => ({ mtimeMs: 0 }))
      }
    })
    await expect(unreadable.handlers.get('pet:backup:findLatest')!(null)).resolves.toMatchObject({
      ok: true,
      found: false
    })

    const partial = harness({
      fs: {
        readdir: vi.fn(async () => [
          file('dsh-pet-broken.petbackup'),
          file('dsh-pet-ok.petbackup')
        ]),
        stat: vi.fn(async (full: string) => {
          if (full.endsWith('broken.petbackup')) throw new Error('EACCES')
          return { mtimeMs: 5 }
        })
      }
    })
    const result = await partial.handlers.get('pet:backup:findLatest')!(null)
    expect(result.fileName).toBe('dsh-pet-ok.petbackup')
  })

  it('setAuto 间隔非法：直接拒绝，不写配置也不碰口令', async () => {
    const { handlers, deps } = harness()

    for (const intervalDays of [-1, 366, 1.5, Number.NaN]) {
      const result = await handlers.get('pet:backup:setAuto')!(null, { intervalDays })
      expect(result).toEqual({
        ok: false,
        reason: 'invalid-interval',
        message: '自动备份间隔需在 0–365 天之间（0 表示关闭）'
      })
    }
    expect(deps.saveBackupPrefs).not.toHaveBeenCalled()
    expect(deps.removeAutoSecret).not.toHaveBeenCalled()
    expect(deps.writeAutoPassword).not.toHaveBeenCalled()
  })

  it('setAuto 设为 0：删除已存口令并关闭开关', async () => {
    const { handlers, deps } = harness()

    const result = await handlers.get('pet:backup:setAuto')!(null, { intervalDays: 0 })

    expect(result).toEqual({ ok: true, intervalDays: 0, hasPassword: false })
    expect(deps.removeAutoSecret).toHaveBeenCalledTimes(1)
    expect(deps.saveBackupPrefs).toHaveBeenCalledWith({
      autoIntervalDays: 0,
      autoStored: false,
      autoLastError: ''
    })
  })

  it('setAuto 新口令不足 8 位：拒绝，不写口令也不落开关', async () => {
    const { handlers, deps } = harness()

    const result = await handlers.get('pet:backup:setAuto')!(null, {
      intervalDays: 7,
      password: '1234567'
    })

    expect(result).toEqual({ ok: false, reason: 'weak-password', message: '自动备份口令至少 8 位' })
    expect(deps.writeAutoPassword).not.toHaveBeenCalled()
    expect(deps.saveBackupPrefs).not.toHaveBeenCalled()
  })

  it('setAuto 未带口令且本地没有可用口令：提示先输入', async () => {
    const { handlers, deps } = harness({ readAutoPassword: vi.fn(async () => 'short') })

    const result = await handlers.get('pet:backup:setAuto')!(null, { intervalDays: 7 })

    expect(result).toEqual({
      ok: false,
      reason: 'need-password',
      message: '自动备份需要先输入一次备份口令'
    })
    expect(deps.saveBackupPrefs).not.toHaveBeenCalled()
  })

  it('setAuto 口令保存失败：不落开关，避免重启后开着却跑不了', async () => {
    const { handlers, deps } = harness({ writeAutoPassword: vi.fn(async () => false) })

    const result = await handlers.get('pet:backup:setAuto')!(null, {
      intervalDays: 7,
      password: 'a-good-password'
    })

    expect(result).toEqual({
      ok: false,
      reason: 'encryption-unavailable',
      message: '本机系统加密不可用，无法安全保存自动备份口令'
    })
    expect(deps.saveBackupPrefs).not.toHaveBeenCalled()
  })

  it('setAuto 成功：先存口令再落开关', async () => {
    const { handlers, deps } = harness()

    const result = await handlers.get('pet:backup:setAuto')!(null, {
      intervalDays: 7,
      password: 'a-good-password'
    })

    expect(result).toEqual({ ok: true, intervalDays: 7, hasPassword: true })
    expect(deps.writeAutoPassword).toHaveBeenCalledWith('a-good-password')
    expect(deps.saveBackupPrefs).toHaveBeenCalledWith({
      autoIntervalDays: 7,
      autoStored: true,
      autoLastError: ''
    })
  })

  it('setAuto 复用已存口令：不重写 secret，只更新开关', async () => {
    const { handlers, deps } = harness({ readAutoPassword: vi.fn(async () => 'stored-password') })

    const result = await handlers.get('pet:backup:setAuto')!(null, { intervalDays: 3 })

    expect(result).toEqual({ ok: true, intervalDays: 3, hasPassword: true })
    expect(deps.writeAutoPassword).not.toHaveBeenCalled()
    expect(deps.saveBackupPrefs).toHaveBeenCalledWith({
      autoIntervalDays: 3,
      autoStored: true,
      autoLastError: ''
    })
  })
})
