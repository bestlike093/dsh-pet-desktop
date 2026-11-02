import { describe, expect, it } from 'vitest'
import { BlobManifest } from '../blobManifest.js'

const HASH = 'a'.repeat(64)

describe('blob 清单与引用计数（S4）', () => {
  it('同一内容两个名字：1 个 blob、2 个引用，删一个另一个仍在', () => {
    const manifest = new BlobManifest()

    expect(manifest.addRef(HASH, 'portrait.png', 1024).created).toBe(true)
    const second = manifest.addRef(HASH, 'portrait-copy.png', 1024)

    expect(second.created).toBe(false)
    expect(manifest.blobCount).toBe(1)
    expect(manifest.refCount).toBe(2)

    const removed = manifest.removeRef(HASH, 'portrait.png')

    expect(removed.removedBlob).toBe(false)
    expect(manifest.refsOf(HASH)).toEqual(['portrait-copy.png'])
    expect(manifest.has(HASH)).toBe(true)
  })

  it('最后一个引用删除后才释放 blob', () => {
    const manifest = new BlobManifest()
    manifest.addRef(HASH, 'a.png', 1024)
    manifest.addRef(HASH, 'b.png', 1024)

    manifest.removeRef(HASH, 'a.png')
    const last = manifest.removeRef(HASH, 'b.png')

    expect(last.removedBlob).toBe(true)
    expect(manifest.blobCount).toBe(0)
    expect(manifest.has(HASH)).toBe(false)
  })

  it('同名重复引用不会重复计数', () => {
    const manifest = new BlobManifest()
    manifest.addRef(HASH, 'a.png', 1024)
    manifest.addRef(HASH, 'a.png', 1024)

    expect(manifest.refCount).toBe(1)
  })

  it('并发写同一 blob：producer 只执行一次', async () => {
    const manifest = new BlobManifest()
    let runs = 0
    let release: () => void = () => {}

    const gate = new Promise<void>((resolve) => {
      release = resolve
    })

    const producer = async (): Promise<void> => {
      runs += 1
      await gate
    }

    const first = manifest.withBlob(HASH, producer)
    const second = manifest.withBlob(HASH, producer)

    expect(runs).toBe(1)
    release()
    await Promise.all([first, second])

    expect(runs).toBe(1)
  })

  it('第一个完成后，后续 withBlob 可以重新进入', async () => {
    const manifest = new BlobManifest()
    let runs = 0

    await manifest.withBlob(HASH, async () => {
      runs += 1
    })
    await manifest.withBlob(HASH, async () => {
      runs += 1
    })

    expect(runs).toBe(2)
  })

  it('producer 失败时清空 in-flight，下一次可以重试', async () => {
    const manifest = new BlobManifest()

    await expect(
      manifest.withBlob(HASH, async () => {
        throw new Error('写 blob 失败')
      })
    ).rejects.toThrow('写 blob 失败')

    await expect(
      manifest.withBlob(HASH, async () => {
        /* 重试成功 */
      })
    ).resolves.toBeUndefined()
  })
})
