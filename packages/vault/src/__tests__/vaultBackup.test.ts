import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  BACKUP_MAX_FILES,
  BACKUP_MAX_FILE_BYTES,
  createVaultBackup,
  openVaultBackup,
  writeRestoredKeyRing
} from '../backup/vaultBackup.js'
import { createFileKeyRing } from '../crypto/fileKeyRing.js'
import { createMemoryBackend } from '../crypto/keyBackend.js'
import { AesGcmProvider } from '../crypto/provider.js'
import { MemoryVaultStorage } from '../store/vaultStore.js'
import { VaultClient } from '../vaultClient.js'

const dirs: string[] = []

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-vault-backup-'))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

describe('.petbackup 导出与恢复', () => {
  it('换一台机器、换一个后端也能解开原 Vault 数据', async () => {
    const sourceDir = await tempDir()
    const sourceBackend = await createMemoryBackend()
    const sourceRing = await createFileKeyRing({
      path: join(sourceDir, 'keys.json'),
      backend: sourceBackend
    })
    const sourceClient = new VaultClient(new MemoryVaultStorage(), new AesGcmProvider(), sourceRing)
    const sealed = await sourceClient.seal(new TextEncoder().encode('跨机可读'), { kind: 'envelope' })

    const backup = await createVaultBackup({
      ring: sourceRing,
      password: 'correct horse battery',
      files: [{ name: 'secrets.bin', data: new Uint8Array([1, 2, 3]) }]
    })
    const serialized = JSON.stringify(backup)
    const rawKey = Buffer.from(sourceRing.current().key).toString('base64')
    expect(serialized).not.toContain(rawKey)

    // 新机器：全新的目录与后端，旧的 keys.json 不存在。
    const targetDir = await tempDir()
    const targetBackend = await createMemoryBackend()
    const restored = await openVaultBackup(JSON.parse(serialized), 'correct horse battery')
    await writeRestoredKeyRing({
      path: join(targetDir, 'keys.json'),
      backend: targetBackend,
      suite: restoredRingSuite(),
      keys: restored.keys,
      signer: restored.signer
    })

    const targetRing = await createFileKeyRing({
      path: join(targetDir, 'keys.json'),
      backend: targetBackend
    })
    const targetClient = new VaultClient(new MemoryVaultStorage(), new AesGcmProvider(), targetRing)
    const plain = await targetClient.open(sealed)
    expect(new TextDecoder().decode(plain)).toBe('跨机可读')
    expect(restored.files[0]?.data).toEqual(new Uint8Array([1, 2, 3]))

    const written = JSON.parse(await readFile(join(targetDir, 'keys.json'), 'utf8')) as {
      signer?: { pub?: unknown }
    }
    expect(typeof written.signer?.pub).toBe('string')
  })

  it('口令错误与参数降级都被拒绝', async () => {
    const dir = await tempDir()
    const ring = await createFileKeyRing({
      path: join(dir, 'keys.json'),
      backend: await createMemoryBackend()
    })
    const backup = await createVaultBackup({ ring, password: 'a-good-password', files: [] })

    await expect(openVaultBackup(backup, 'wrong-password')).rejects.toMatchObject({
      code: 'VAULT_TAMPERED'
    })
    await expect(
      openVaultBackup(
        { ...backup, kdf: { ...backup.kdf, iterations: 1000 } },
        'a-good-password'
      )
    ).rejects.toMatchObject({ code: 'CRYPTO_SUITE_UNSUPPORTED' })
    await expect(
      createVaultBackup({ ring, password: 'short', files: [] })
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  })

  /** 破坏性用例：被篡改或版本不符的包必须整包拒收，不能半拉子解出内容。 */
  it('版本号不符与密文被改都整包拒收', async () => {
    const dir = await tempDir()
    const ring = await createFileKeyRing({
      path: join(dir, 'keys.json'),
      backend: await createMemoryBackend()
    })
    const password = 'a-good-password'
    const backup = await createVaultBackup({ ring, password, files: [] })

    await expect(
      openVaultBackup({ ...backup, version: 999 }, password)
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(
      openVaultBackup({ ...backup, format: 'not-a-petbackup' }, password)
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })

    // 翻转密文里第一个字符串字段的首字符，模拟被改过一字节的包。
    const sealed = backup.sealed as unknown
    let tamperedSealed: unknown = sealed
    if (typeof sealed === 'string') {
      tamperedSealed = `${sealed[0] === 'A' ? 'B' : 'A'}${sealed.slice(1)}`
    } else if (sealed !== null && typeof sealed === 'object') {
      const copy: Record<string, any> = { ...(sealed as Record<string, unknown>) }
      const name = Object.keys(copy).find((key) => typeof copy[key] === 'string')
      if (name !== undefined) {
        copy[name] = `${copy[name][0] === 'A' ? 'B' : 'A'}${copy[name].slice(1)}`
      }
      tamperedSealed = copy
    }

    await expect(
      openVaultBackup({ ...backup, sealed: tamperedSealed }, password)
    ).rejects.toMatchObject({ code: 'VAULT_TAMPERED' })
  })

  it('条目数量与单条体积都有上限', async () => {
    const dir = await tempDir()
    const ring = await createFileKeyRing({
      path: join(dir, 'keys.json'),
      backend: await createMemoryBackend()
    })
    const password = 'a-good-password'

    await expect(
      createVaultBackup({
        ring,
        password,
        files: Array.from({ length: BACKUP_MAX_FILES + 1 }, (_, index) => ({
          name: `f${index}.bin`,
          data: new Uint8Array(0)
        }))
      })
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })

    await expect(
      createVaultBackup({
        ring,
        password,
        files: [{ name: 'big.bin', data: new Uint8Array(BACKUP_MAX_FILE_BYTES + 1) }]
      })
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })

    // 导入侧在解密前就按条目数拒绝，不必先跑 600k 次 PBKDF2。
    const backup = await createVaultBackup({ ring, password, files: [] })
    await expect(
      openVaultBackup(
        {
          ...backup,
          files: Array.from({ length: BACKUP_MAX_FILES + 1 }, () => ({ name: 'x', data: '' }))
        },
        password
      )
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  })
})

function restoredRingSuite(): string {
  return new AesGcmProvider().suite
}
