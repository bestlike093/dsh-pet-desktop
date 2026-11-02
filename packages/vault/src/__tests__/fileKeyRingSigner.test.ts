import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createFileKeyRing } from '../crypto/fileKeyRing.js'
import { createMemoryBackend } from '../crypto/keyBackend.js'

const dirs: string[] = []

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-vault-signer-'))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

describe('FileKeyRing 签名密钥持久化', () => {
  it('同一份 keys.json 连续两次加载，senderPub 不变', async () => {
    const dir = await tempDir()
    const path = join(dir, 'keys.json')
    const backend = await createMemoryBackend()

    const first = await createFileKeyRing({ path, backend })
    const pub1 = await first.senderPub()
    first.destroy()

    const second = await createFileKeyRing({ path, backend })
    const pub2 = await second.senderPub()

    expect(pub2).toBe(pub1)
    expect((await second.diagnostics()).signerState).toBe('ok')
  })

  it('旧文件缺 signer 字段时补写，AES 密钥保持不变', async () => {
    const dir = await tempDir()
    const path = join(dir, 'keys.json')
    const backend = await createMemoryBackend()

    const first = await createFileKeyRing({ path, backend })
    const keyBefore = Buffer.from(first.current().key).toString('hex')
    first.destroy()

    // 模拟升级前的 keys.json：只有密钥条目，没有 signer。
    const legacy = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    delete legacy['signer']
    await writeFile(path, JSON.stringify(legacy), 'utf8')

    const second = await createFileKeyRing({ path, backend })
    expect(Buffer.from(second.current().key).toString('hex')).toBe(keyBefore)

    await second.senderPub()
    const migrated = JSON.parse(await readFile(path, 'utf8')) as {
      signer?: { wrapped?: unknown; pub?: unknown }
    }
    expect(typeof migrated.signer?.wrapped).toBe('string')
    expect(typeof migrated.signer?.pub).toBe('string')
    expect((await second.diagnostics()).signerState).toBe('ok')
  })
})
