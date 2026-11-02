import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createFileKeyRing } from '../crypto/fileKeyRing.js'
import { createMemoryBackend } from '../crypto/keyBackend.js'
import { AesGcmProvider } from '../crypto/provider.js'
import { KeyRingVaultStore } from '../store/keyRingVaultStore.js'
import { MemoryVaultStorage } from '../store/vaultStore.js'
import { VaultClient } from '../vaultClient.js'

const dirs: string[] = []

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-ringvault-'))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

async function makeStore(
  ringPath: string,
  storage: MemoryVaultStorage,
  backend?: Awaited<ReturnType<typeof createMemoryBackend>>
) {
  const actualBackend = backend ?? (await createMemoryBackend())
  const ring = await createFileKeyRing({ path: ringPath, backend: actualBackend })
  const client = new VaultClient(new MemoryVaultStorage(), new AesGcmProvider(), ring)
  return new KeyRingVaultStore({ client, storage })
}

describe('KeyRingVaultStore（S-4 接线用适配层）', () => {
  it('空文件读出 null', async () => {
    const dir = await tempDir()
    const store = await makeStore(join(dir, 'keys.json'), new MemoryVaultStorage())
    await expect(store.load()).resolves.toBeNull()
  })

  it('写入后能读回同一份数据', async () => {
    const dir = await tempDir()
    const store = await makeStore(join(dir, 'keys.json'), new MemoryVaultStorage())

    await store.save({ 'service.weather.apiKey': 'abc123' })

    await expect(store.load()).resolves.toEqual({ 'service.weather.apiKey': 'abc123' })
  })

  it('落盘内容不含明文', async () => {
    const dir = await tempDir()
    const storage = new MemoryVaultStorage()
    const store = await makeStore(join(dir, 'keys.json'), storage)

    await store.save({ 'service.weather.apiKey': 'PLAINTEXT-SECRET' })

    expect(storage.raw()).not.toContain('PLAINTEXT-SECRET')
    expect(storage.raw()).toContain('"cipher"')
  })

  it('同一实例连续读两次不会触发重放拦截', async () => {
    const dir = await tempDir()
    const ringPath = join(dir, 'keys.json')
    const ring = await createFileKeyRing({ path: ringPath, backend: await createMemoryBackend() })
    const client = new VaultClient(new MemoryVaultStorage(), new AesGcmProvider(), ring)
    const store = new KeyRingVaultStore({ client, storage: new MemoryVaultStorage() })

    await store.save({ a: 1 })
    expect(await store.load()).toEqual({ a: 1 })
    expect(await store.load()).toEqual({ a: 1 })
  })

  it('换一个实例读同一份密文也能解开（模拟重启，同一后端）', async () => {
    const dir = await tempDir()
    const ringPath = join(dir, 'keys.json')
    const storage = new MemoryVaultStorage()
    const backend = await createMemoryBackend()

    const first = await makeStore(ringPath, storage, backend)
    await first.save({ token: 'hello' })

    const second = await makeStore(ringPath, storage, backend)
    await expect(second.load()).resolves.toEqual({ token: 'hello' })
  })

  it('密文被改动后拒绝解密', async () => {
    const dir = await tempDir()
    const ringPath = join(dir, 'keys.json')
    const storage = new MemoryVaultStorage()
    const store = await makeStore(ringPath, storage)

    await store.save({ token: 'hello' })

    const raw = storage.raw() ?? ''
    const parsed = JSON.parse(raw) as { cipher: string }
    const flipped = parsed.cipher.slice(0, -2) + (parsed.cipher.endsWith('A') ? 'BB' : 'AA')
    storage.tamper(JSON.stringify({ ...parsed, cipher: flipped }))

    const reopened = await makeStore(ringPath, storage)
    await expect(reopened.load()).rejects.toThrow()
  })

  it('文件不是合法 JSON 时报 VAULT_TAMPERED', async () => {
    const dir = await tempDir()
    const storage = new MemoryVaultStorage()
    storage.tamper('not json at all')

    const store = await makeStore(join(dir, 'keys.json'), storage)
    await expect(store.load()).rejects.toThrowError(/不是合法 JSON/)
  })

  it('缺少必要字段时拒绝', async () => {
    const dir = await tempDir()
    const storage = new MemoryVaultStorage()
    storage.tamper(JSON.stringify({ cipher: 'abc' }))

    const store = await makeStore(join(dir, 'keys.json'), storage)
    await expect(store.load()).rejects.toThrowError(/缺少必要字段/)
  })

  it('save 之后缓存同步更新', async () => {
    const dir = await tempDir()
    const store = await makeStore(join(dir, 'keys.json'), new MemoryVaultStorage())

    await store.save({ v: 1 })
    await store.save({ v: 2 })

    await expect(store.load()).resolves.toEqual({ v: 2 })
  })
})
