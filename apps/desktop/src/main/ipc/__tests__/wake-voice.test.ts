import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { registerWakeVoiceChannels, validateManifest, type WakeVoiceDeps } from '../wake-voice.js'

type Handler = (event: unknown, payload?: unknown) => Promise<Record<string, any>>

const sha = (text: string) => createHash('sha256').update(text).digest('hex')

/** 内存文件系统：只实现唤醒模块用到的那几个方法，能断言最终落盘结果。 */
function memoryFs(seed: Record<string, string> = {}) {
  const files = new Map<string, Uint8Array>()
  const dirs = new Set<string>(['/user'])
  for (const [path, value] of Object.entries(seed)) files.set(path, Buffer.from(value))

  const normalize = (path: string) => path.replace(/\/+/g, '/').replace(/\/$/, '')
  const join = (...parts: string[]) => normalize(parts.filter(Boolean).join('/'))

  const fs: WakeVoiceDeps['fs'] = {
    readFile: async (path) => {
      const data = files.get(normalize(path))
      if (data === undefined) throw new Error(`ENOENT ${path}`)
      return Buffer.from(data).toString('utf8')
    },
    writeFile: async (path, data) => {
      files.set(normalize(path), typeof data === 'string' ? Buffer.from(data) : data)
    },
    mkdir: async (path) => {
      dirs.add(normalize(path))
    },
    rm: async (path) => {
      const target = normalize(path)
      for (const key of [...files.keys()]) {
        if (key === target || key.startsWith(`${target}/`)) files.delete(key)
      }
      for (const dir of [...dirs]) {
        if (dir === target || dir.startsWith(`${target}/`)) dirs.delete(dir)
      }
    },
    rename: async (from, to) => {
      const source = normalize(from)
      const target = normalize(to)
      for (const [key, value] of [...files.entries()]) {
        if (key === source || key.startsWith(`${source}/`)) {
          files.delete(key)
          files.set(key.replace(source, target), value)
        }
      }
    },
    stat: async (path) => {
      const target = normalize(path)
      for (const [key, value] of files.entries()) {
        if (key === target) return { size: value.length, isDirectory: () => false }
      }
      // 目录不单独登记：有子文件就算目录，避免 rename 之后目录表不同步。
      for (const key of files.keys()) {
        if (key.startsWith(`${target}/`)) return { size: 0, isDirectory: () => true }
      }
      if (dirs.has(target)) return { size: 0, isDirectory: () => true }
      throw new Error(`ENOENT ${path}`)
    },
    readdir: async (path) => {
      const target = normalize(path)
      const names = new Set<string>()
      for (const key of [...files.keys(), ...dirs]) {
        if (!key.startsWith(`${target}/`)) continue
        names.add(key.slice(target.length + 1).split('/')[0] as string)
      }
      if (names.size === 0) throw new Error(`ENOENT ${path}`)
      return [...names]
    }
  }

  return { fs, files, dirs, join }
}

function harness(overrides: Partial<WakeVoiceDeps> = {}) {
  const handlers = new Map<string, Handler>()
  const store = memoryFs()
  const deps: WakeVoiceDeps = {
    registerChannel: (channel, listener) => {
      handlers.set(channel, listener as Handler)
    },
    userData: '/user',
    manifestUrl: 'https://example.test/wake.json',
    fetchJson: async () => ({
      version: '1.2.0',
      files: [{ path: 'bin/engine.bin', url: 'https://example.test/engine.bin', sha256: sha('engine') }]
    }),
    downloadBytes: async () => Buffer.from('engine'),
    sha256: (bytes) => sha(Buffer.from(bytes).toString('utf8')),
    fs: store.fs,
    pathJoin: store.join,
    log: vi.fn(),
    describeError: (error) => (error instanceof Error ? error.message : String(error)),
    ...overrides
  }

  const api = registerWakeVoiceChannels(deps)
  return { handlers, deps, store, api }
}

describe('唤醒运行时清单校验', () => {
  it('接受 https + sha256 的清单', () => {
    const manifest = validateManifest({
      version: '1.0.0',
      files: [{ path: 'bin/a.bin', url: 'https://e.test/a.bin', sha256: sha('a') }]
    })
    expect(manifest.files[0]?.path).toBe('bin/a.bin')
  })

  it('拒绝 http、越界路径与缺 sha256 的条目', () => {
    const base = { version: '1.0.0' }
    expect(() =>
      validateManifest({
        ...base,
        files: [{ path: 'a.bin', url: 'http://e.test/a.bin', sha256: sha('a') }]
      })
    ).toThrow()
    expect(() =>
      validateManifest({
        ...base,
        files: [{ path: '../evil.bin', url: 'https://e.test/a.bin', sha256: sha('a') }]
      })
    ).toThrow()
    expect(() =>
      validateManifest({ ...base, files: [{ path: 'a.bin', url: 'https://e.test/a.bin' }] })
    ).toThrow()
  })

  it('体积超上限整单拒绝', () => {
    expect(() =>
      validateManifest({
        version: '1.0.0',
        totalBytes: 700 * 1024 * 1024,
        files: [{ path: 'a.bin', url: 'https://e.test/a.bin', sha256: sha('a') }]
      })
    ).toThrow()
  })
})

describe('语音唤醒通道', () => {
  it('默认关闭且未安装', async () => {
    const { handlers } = harness()
    const status = await handlers.get('pet:wake:status')!(null)
    expect(status).toMatchObject({ ok: true, enabled: false, installed: false, installedVersion: null })
  })

  it('安装成功后写入状态与文件，启停跟随用户选择', async () => {
    const { handlers, store } = harness()
    const result = await handlers.get('pet:wake:install')!(null)
    expect(result).toMatchObject({ ok: true, version: '1.2.0', fileCount: 1 })
    expect(store.files.has('/user/wake-engine/1.2.0/bin/engine.bin')).toBe(true)

    const status = await handlers.get('pet:wake:status')!(null)
    expect(status.installed).toBe(true)
    expect(status.enabled).toBe(false)

    expect(await handlers.get('pet:wake:setEnabled')!(null, { enabled: true })).toMatchObject({
      ok: true,
      enabled: true
    })
    expect(await handlers.get('pet:wake:status')!(null)).toMatchObject({ enabled: true })
  })

  it('没装运行时不允许打开开关', async () => {
    const { handlers } = harness()
    const result = await handlers.get('pet:wake:setEnabled')!(null, { enabled: true })
    expect(result).toMatchObject({ ok: false, reason: 'not-installed' })
  })

  it('没有下载源时说明原因，不假装在下载', async () => {
    const { handlers } = harness({ manifestUrl: null })
    const result = await handlers.get('pet:wake:install')!(null)
    expect(result).toMatchObject({ ok: false, reason: 'no-manifest' })
  })

  it('sha256 对不上时整次回滚，不留半套文件', async () => {
    const { handlers, store } = harness({ downloadBytes: async () => Buffer.from('tampered') })
    const result = await handlers.get('pet:wake:install')!(null)
    expect(result).toMatchObject({ ok: false, reason: 'failed' })
    expect(store.files.has('/user/wake-engine/.staging')).toBe(false)
    const status = await handlers.get('pet:wake:status')!(null)
    expect(status.installed).toBe(false)
  })

  it('删除运行时同时把开关关掉', async () => {
    const { handlers } = harness()
    await handlers.get('pet:wake:install')!(null)
    await handlers.get('pet:wake:setEnabled')!(null, { enabled: true })
    expect(await handlers.get('pet:wake:remove')!(null)).toEqual({ ok: true })
    expect(await handlers.get('pet:wake:status')!(null)).toMatchObject({
      enabled: false,
      installed: false,
      installedVersion: null
    })
  })

  it('状态文件损坏时按默认值启动，不抛错', async () => {
    const store = memoryFs({ '/user/wake-voice.json': '{ not json' })
    const { handlers } = harness({ fs: store.fs, pathJoin: store.join })
    const status = await handlers.get('pet:wake:status')!(null)
    expect(status).toMatchObject({ ok: true, enabled: false, installedVersion: null })
  })

  it('isEnabled 只有装了且打开才为真', async () => {
    const { handlers, api } = harness()
    expect(api.isEnabled()).toBe(false)
    await handlers.get('pet:wake:install')!(null)
    expect(api.isEnabled()).toBe(false)
    await handlers.get('pet:wake:setEnabled')!(null, { enabled: true })
    expect(api.isEnabled()).toBe(true)
  })

  it('重启后没读过状态之前不放行麦克风，init 之后才按存盘值恢复', async () => {
    const store = memoryFs({
      '/user/wake-voice.json': JSON.stringify({ enabled: true, installedVersion: '1.2.0' }),
      '/user/wake-engine/1.2.0/bin/engine.bin': 'engine'
    })
    const { api } = harness({ fs: store.fs, pathJoin: store.join })
    // 主进程还没读完盘，权限检查必须按「关闭」处理。
    expect(api.isEnabled()).toBe(false)
    await api.init()
    expect(api.isEnabled()).toBe(true)
  })

  it('存盘里是关着的，init 之后依然不放行', async () => {
    const store = memoryFs({
      '/user/wake-voice.json': JSON.stringify({ enabled: false, installedVersion: '1.2.0' }),
      '/user/wake-engine/1.2.0/bin/engine.bin': 'engine'
    })
    const { api } = harness({ fs: store.fs, pathJoin: store.join })
    await api.init()
    expect(api.isEnabled()).toBe(false)
  })

  it('开关结果带回版本号，设置页不用再查一次', async () => {
    const { handlers } = harness()
    await handlers.get('pet:wake:install')!(null)
    expect(await handlers.get('pet:wake:setEnabled')!(null, { enabled: true })).toMatchObject({
      ok: true,
      enabled: true,
      installedVersion: '1.2.0'
    })
  })
})
