import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTempWorkspace, sweepStaleTmp, tmpRoot } from '../tempWorkspace.js'

let root = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-assets-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('临时目录（S4 第一步）', () => {
  it('.tmp 固定在 assetsRoot 之内', () => {
    const dir = tmpRoot(root)

    expect(dir).toBe(resolve(root, '.tmp'))
    expect(dir.startsWith(resolve(root) + sep)).toBe(true)
  })

  it('临时文件名用随机 UUID，不沿用原始文件名', async () => {
    const workspace = await createTempWorkspace(root, '.png')
    const name = workspace.path.slice(workspace.dir.length + 1)

    expect(name).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.png$/)
    expect(name).not.toContain('..')
    expect(name).not.toContain('evil')
  })

  it('非法扩展名被丢弃，不会带进路径', async () => {
    const workspace = await createTempWorkspace(root, '../../evil.js')

    expect(workspace.path.endsWith('.js')).toBe(false)
    expect(workspace.path.slice(workspace.dir.length + 1)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    )
  })

  it('dispose 幂等删除临时文件', async () => {
    const workspace = await createTempWorkspace(root, '.webm')
    await writeFile(workspace.path, new Uint8Array([1, 2, 3]))

    await workspace.dispose()
    await workspace.dispose()

    await expect(readdir(workspace.dir)).resolves.toEqual([])
  })

  it('启动清理只删超过 24h 的残留', async () => {
    const dir = tmpRoot(root)
    const oldPath = join(dir, 'old.bin')
    const freshPath = join(dir, 'fresh.bin')

    const workspace = await createTempWorkspace(root, '.bin')
    await writeFile(oldPath, new Uint8Array([1]))
    await writeFile(freshPath, new Uint8Array([2]))
    await utimes(oldPath, new Date('2026-10-01T00:00:00Z'), new Date('2026-10-01T00:00:00Z'))
    await utimes(freshPath, new Date(), new Date())

    const removed = await sweepStaleTmp(root, { now: Date.now() })

    expect(removed).toEqual(['old.bin'])
    await expect(readdir(dir)).resolves.toEqual(['fresh.bin'])
    await workspace.dispose()
  })

  it('清理不会碰 assetsRoot 之外的条目', async () => {
    const dir = tmpRoot(root)
    const outside = join(root, 'outside.bin')
    const inside = join(dir, 'inside.bin')

    await mkdir(dir, { recursive: true })
    await writeFile(outside, new Uint8Array([1]))
    await writeFile(inside, new Uint8Array([2]))
    const past = new Date('2026-10-01T00:00:00Z')
    await utimes(outside, past, past)
    await utimes(inside, past, past)

    await sweepStaleTmp(root, { now: Date.now() })

    await expect(readdir(root)).resolves.toContain('outside.bin')
    await expect(readdir(dir)).resolves.toEqual([])
  })
})
