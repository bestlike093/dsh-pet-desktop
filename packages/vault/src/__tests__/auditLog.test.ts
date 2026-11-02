import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ErrorCode } from '@pet/shared'
import { createAuditLog } from '../audit/auditLog.js'
import { createFileKeyRing } from '../crypto/fileKeyRing.js'
import { createMemoryBackend } from '../crypto/keyBackend.js'
import { AesGcmProvider } from '../crypto/provider.js'
import { MemoryVaultStorage } from '../store/vaultStore.js'
import { VaultClient } from '../vaultClient.js'

const dirs: string[] = []

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-audit-'))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

describe('append-only 审计日志（S1 第 7 步）', () => {
  it('追加后 seq 递增、prevHash 链自洽', async () => {
    const dir = await tempDir()
    const path = join(dir, 'audit.log')
    const log = await createAuditLog(path)

    await log.append('seal', { keyId: 1, size: 3 })
    await log.append('open', { keyId: 1, size: 3 })
    await log.append('rotate', { epoch: 1 })

    const entries = await log.entries()
    expect(entries.map((entry) => entry.seq)).toEqual([1, 2, 3])
    expect(entries[0]?.prevHash).toBe('0'.repeat(64))
    expect(entries[1]?.prevHash).toBe(entries[0]?.hash)
    expect(entries[2]?.prevHash).toBe(entries[1]?.hash)
    await expect(log.verify()).resolves.toBeUndefined()
  })

  it('并发追加不会互相覆盖', async () => {
    const dir = await tempDir()
    const path = join(dir, 'audit.log')
    const log = await createAuditLog(path)

    await Promise.all(
      Array.from({ length: 10 }, (_, index) => log.append('seal', { keyId: index + 1 }))
    )

    const entries = await log.entries()
    expect(entries).toHaveLength(10)
    expect(entries.map((entry) => entry.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    await expect(log.verify()).resolves.toBeUndefined()
  })

  it('改写中间行 → VAULT_TAMPERED', async () => {
    const dir = await tempDir()
    const path = join(dir, 'audit.log')
    const log = await createAuditLog(path)
    await log.append('seal', { keyId: 1, size: 3 })
    await log.append('open', { keyId: 1, size: 3 })
    await log.append('rotate', { epoch: 1 })

    const lines = (await readFile(path, 'utf8')).trimEnd().split('\n')
    const second = JSON.parse(lines[1] ?? '{}') as { details: { size?: number } }
    second.details.size = 999
    lines[1] = JSON.stringify(second)
    await writeFile(path, lines.join('\n') + '\n', 'utf8')

    await expect(createAuditLog(path)).rejects.toMatchObject({
      code: ErrorCode.VAULT_TAMPERED
    })
  })

  it('删除中间行 → VAULT_TAMPERED', async () => {
    const dir = await tempDir()
    const path = join(dir, 'audit.log')
    const log = await createAuditLog(path)
    await log.append('seal', { keyId: 1 })
    await log.append('open', { keyId: 1 })
    await log.append('rotate', { epoch: 1 })

    const lines = (await readFile(path, 'utf8')).trimEnd().split('\n')
    await writeFile(path, [lines[0], lines[2]].join('\n') + '\n', 'utf8')

    await expect(createAuditLog(path)).rejects.toMatchObject({
      code: ErrorCode.VAULT_TAMPERED
    })
  })

  it('tamper_detected 作为审计事件可追加', async () => {
    const dir = await tempDir()
    const path = join(dir, 'audit.log')
    const log = await createAuditLog(path)

    const entry = await log.append('tamper_detected', {
      code: ErrorCode.VAULT_TAMPERED,
      note: 'keys.json 哈希不匹配'
    })

    expect(entry.event).toBe('tamper_detected')
    expect(entry.details.code).toBe(ErrorCode.VAULT_TAMPERED)
    await expect(log.verify()).resolves.toBeUndefined()
  })

  it('VaultClient 把 seal/open/rotate/tamper 写进审计链', async () => {
    const dir = await tempDir()
    const audit = await createAuditLog(join(dir, 'audit.log'))
    const ring = await createFileKeyRing({
      path: join(dir, 'keys.json'),
      backend: await createMemoryBackend()
    })
    const client = new VaultClient(new MemoryVaultStorage(), new AesGcmProvider(), ring, audit)

    const sealed = await client.seal(new Uint8Array([1, 2]), { kind: 'envelope' })
    await client.open(sealed)
    await client.rotate()

    expect((await audit.entries()).map((entry) => entry.event)).toEqual(['seal', 'open', 'rotate'])

    await expect(
      client.open({ ...sealed, cipher: 'AAAA' }, { allowLegacyEpoch: true })
    ).rejects.toMatchObject({ code: ErrorCode.VAULT_TAMPERED })

    const events = (await audit.entries()).map((entry) => entry.event)
    expect(events[events.length - 1]).toBe('tamper_detected')
  })
})
