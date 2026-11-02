import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  SYSTEM_SID,
  WIDE_ACL_SIDS,
  createFileKeyRing,
  evaluateAclSids
} from '../crypto/fileKeyRing.js'
import { createMemoryBackend, createSafeStorageBackend } from '../crypto/keyBackend.js'
import { AesGcmProvider } from '../crypto/provider.js'
import { MemoryVaultStorage } from '../store/vaultStore.js'
import { VaultClient } from '../vaultClient.js'

const dirs: string[] = []

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-vault-'))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

describe('FileKeyRing（S1 第 6 步）', () => {
  it('seal 后密钥文件落盘，读回 open 成功', async () => {
    const dir = await tempDir()
    const path = join(dir, 'keys.json')
    const backend = await createMemoryBackend()

    const ring = await createFileKeyRing({ path, backend })
    const client = new VaultClient(new MemoryVaultStorage(), new AesGcmProvider(), ring)
    const sealed = await client.seal(new Uint8Array([9, 8, 7]), { kind: 'envelope' })

    const text = await readFile(path, 'utf8')
    expect(text).toContain('"version":1')
    expect(text).toContain('"backend":"memory"')

    const rawKeyHex = Buffer.from(ring.current().key).toString('hex')
    expect(text.toLowerCase()).not.toContain(rawKeyHex)

    const reopened = await createFileKeyRing({ path, backend })
    const client2 = new VaultClient(new MemoryVaultStorage(), new AesGcmProvider(), reopened)
    await expect(client2.open(sealed)).resolves.toEqual(new Uint8Array([9, 8, 7]))
  })

  it('权限：当前用户可读写，其他非提权用户不可读', async () => {
    const dir = await tempDir()
    const path = join(dir, 'keys.json')
    const ring = await createFileKeyRing({ path, backend: await createMemoryBackend() })

    const diagnostic = await ring.diagnostics()
    expect(diagnostic.permission).toBe('ok')

    if (process.platform !== 'win32') {
      const info = await stat(path)
      expect(info.mode & 0o077).toBe(0)
    }
  })

  it('诊断显示后端类型与 secure 标记', async () => {
    const dir = await tempDir()
    const ring = await createFileKeyRing({
      path: join(dir, 'keys.json'),
      backend: await createMemoryBackend()
    })

    const diagnostic = await ring.diagnostics()
    expect(diagnostic.backend).toBe('memory')
    expect(diagnostic.secure).toBe(false)
    expect(diagnostic.path).toBe(join(dir, 'keys.json'))
  })

  it('safeStorage basic_text 后端标记为不安全', async () => {
    const backend = createSafeStorageBackend({
      isEncryptionAvailable: () => true,
      getSelectedStorageBackend: () => 'basic_text',
      encryptString: (plain) => Buffer.from(plain, 'utf8'),
      decryptString: (encrypted) => Buffer.from(encrypted).toString('utf8')
    })

    expect(backend.secure).toBe(false)
    const wrapped = await backend.wrap(new Uint8Array([1, 2, 3]))
    await expect(backend.unwrap(wrapped)).resolves.toEqual(new Uint8Array([1, 2, 3]))
  })

  it('rotate 后文件保留两条密钥，旧信封需显式放行', async () => {
    const dir = await tempDir()
    const path = join(dir, 'keys.json')
    const backend = await createMemoryBackend()
    const ring = await createFileKeyRing({ path, backend })
    const client = new VaultClient(new MemoryVaultStorage(), new AesGcmProvider(), ring)

    const oldSealed = await client.seal(new Uint8Array([1]), { kind: 'envelope' })
    await client.rotate()

    const afterRotate = JSON.parse(await readFile(path, 'utf8')) as { keys: unknown[] }
    expect(afterRotate.keys).toHaveLength(2)

    const reopened = await createFileKeyRing({ path, backend })
    const client2 = new VaultClient(new MemoryVaultStorage(), new AesGcmProvider(), reopened)
    await expect(client2.open(oldSealed)).rejects.toThrow()
    await expect(client2.open(oldSealed, { allowLegacyEpoch: true })).resolves.toEqual(
      new Uint8Array([1])
    )
  })

  /**
   * 契约用例：落盘失败时不能出现「进程内新密钥 / 磁盘旧密钥」的分叉。
   *
   * 要求同时满足三条：内存 current 仍是旧 key；后续 seal 继续用旧 key；
   * 磁盘 ring 不含 next。以后若有人把顺序改回「先改内存再落盘」，这条会红。
   */
  it('rotate 落盘失败：内存仍用旧 key，磁盘不含 next', async () => {
    const dir = await tempDir()
    const path = join(dir, 'keys.json')
    const backend = await createMemoryBackend()
    const ring = await createFileKeyRing({ path, backend })
    const client = new VaultClient(new MemoryVaultStorage(), new AesGcmProvider(), ring)

    const sealed = await client.seal(new Uint8Array([4, 5, 6]), { kind: 'envelope' })
    const epochBefore = ring.current().epoch
    const keyIdBefore = ring.current().keyId
    const diskBefore = await readFile(path, 'utf8')
    const epochsBefore = (JSON.parse(diskBefore) as { keys: Array<{ epoch: number }> }).keys.map(
      (entry) => entry.epoch
    )

    // 第一条密钥正常包裹，第二条抛错：模拟写到一半磁盘不可用。
    const originalWrap = backend.wrap.bind(backend)
    let wraps = 0
    backend.wrap = async (key: Uint8Array) => {
      wraps += 1
      if (wraps > 1) throw new Error('disk full')
      return originalWrap(key)
    }

    await expect(client.rotate()).rejects.toThrow('disk full')

    // 内存仍停在旧 key，旧信封照常可读。
    expect(ring.current().epoch).toBe(epochBefore)
    expect(ring.current().keyId).toBe(keyIdBefore)
    await expect(client.open(sealed)).resolves.toEqual(new Uint8Array([4, 5, 6]))

    // 恢复 backend 后继续加密，仍然用旧 key，没有偷偷启用 next。
    backend.wrap = originalWrap
    const after = await client.seal(new Uint8Array([7]), { kind: 'envelope' })
    expect(after.keyEpoch).toBe(epochBefore)

    // 磁盘 ring 逐字节未变，也不含 next 的 epoch。
    expect(await readFile(path, 'utf8')).toBe(diskBefore)
    const epochsAfter = (
      JSON.parse(await readFile(path, 'utf8')) as { keys: Array<{ epoch: number }> }
    ).keys.map((entry) => entry.epoch)
    expect(epochsAfter).toEqual(epochsBefore)
  })
})

describe('ACL 判定按 SID，不看本地化组名', () => {
  const me = 'S-1-5-21-1111-2222-3333-1001'

  it('只有当前用户与 SYSTEM 时算 ok', () => {
    expect(evaluateAclSids([me, SYSTEM_SID], me)).toBe('ok')
  })

  it('Everyone 在列表里就是过宽', () => {
    expect(evaluateAclSids([me, 'S-1-1-0'], me)).toBe('too-open')
  })

  it('Users 组在列表里也算过宽', () => {
    expect(evaluateAclSids([me, 'S-1-5-32-545'], me)).toBe('too-open')
  })

  it('Authenticated Users 算过宽', () => {
    expect(evaluateAclSids(['S-1-5-11'], me)).toBe('too-open')
  })

  it('Guests 算过宽', () => {
    expect(evaluateAclSids(['S-1-5-32-546'], me)).toBe('too-open')
  })

  it('拿不到当前用户 SID 时 unknown', () => {
    expect(evaluateAclSids([me], null)).toBe('unknown')
  })

  it('空 ACL 是 unknown', () => {
    expect(evaluateAclSids([], me)).toBe('unknown')
  })

  it('只有别人的 SID 时 unknown', () => {
    expect(evaluateAclSids([SYSTEM_SID], me)).toBe('unknown')
  })

  it('宽泛名单覆盖四类主体', () => {
    expect(WIDE_ACL_SIDS).toEqual(
      expect.arrayContaining(['S-1-1-0', 'S-1-5-32-545', 'S-1-5-11', 'S-1-5-32-546'])
    )
  })
})

describe('密钥文件原子落盘', () => {
  it('写完不留临时文件', async () => {
    const dir = await tempDir()
    const path = join(dir, 'keys.json')
    await createFileKeyRing({ path, backend: await createMemoryBackend() })

    const entries = (await readdir(dir)).sort()
    expect(entries).toEqual(['keys.json'])
  })

  it('轮转后文件仍是完整 JSON', async () => {
    const dir = await tempDir()
    const path = join(dir, 'keys.json')
    const ring = await createFileKeyRing({ path, backend: await createMemoryBackend() })

    await ring.rotate()

    const parsed = JSON.parse(await readFile(path, 'utf8')) as { keys: unknown[] }
    expect(parsed.keys).toHaveLength(2)
    expect((await readdir(dir)).sort()).toEqual(['keys.json'])
  })
})
