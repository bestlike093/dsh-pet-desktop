import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ErrorCode, PetError } from '@pet/shared'
import { digestFile } from '../streamDigest.js'

let root = ''
let file = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-digest-'))
  file = join(root, 'payload.bin')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('流式 SHA 与头部读取（S4）', () => {
  it('一次读取同时产出头部与摘要', async () => {
    const bytes = new Uint8Array(1024 * 1024)
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = index % 251
    await writeFile(file, bytes)

    const result = await digestFile(file, { maxBytes: 2 * 1024 * 1024 })

    expect(result.size).toBe(bytes.length)
    expect(result.sha256).toBe(createHash('sha256').update(bytes).digest('hex'))
    expect(Array.from(result.head)).toEqual(Array.from(bytes.subarray(0, 512)))
  })

  it('超过上限时中途中止，不读完再判', async () => {
    const bytes = new Uint8Array(2 * 1024 * 1024)
    await writeFile(file, bytes)

    let caught: PetError | undefined
    try {
      await digestFile(file, { maxBytes: 1000, chunkSize: 64 * 1024 })
    } catch (error) {
      caught = error as PetError
    }

    expect(caught).toBeInstanceOf(PetError)
    expect(caught?.code).toBe(ErrorCode.QUOTA_EXCEEDED)

    const details = caught?.details as { readBytes: number; maxBytes: number }
    expect(details.maxBytes).toBe(1000)
    // 只多读一个 chunk，说明没有把 2MB 全读完。
    expect(details.readBytes).toBeLessThanOrEqual(1000 + 64 * 1024)
    expect(details.readBytes).toBeLessThan(bytes.length)
  })

  it('空文件产出空摘要与空头部', async () => {
    await writeFile(file, new Uint8Array(0))

    const result = await digestFile(file, { maxBytes: 1024 })

    expect(result.size).toBe(0)
    expect(result.sha256).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(result.head).toHaveLength(0)
  })

  it('读取失败时不产出摘要（文件不存在）', async () => {
    await expect(digestFile(join(root, 'missing.bin'), { maxBytes: 1024 })).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })
})
