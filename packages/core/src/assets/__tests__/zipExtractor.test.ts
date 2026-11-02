import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ErrorCode, assertPersistableCode, type PetError } from '@pet/shared'
import { extractZipSafely } from '../zipExtractor.js'
import { makeZip, type FixtureEntry } from './zipFixture.js'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01])

let root = ''
let zipPath = ''
let dest = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-zip-'))
  zipPath = join(root, 'upload.zip')
  dest = join(root, 'out')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function writeZip(entries: readonly FixtureEntry[]): Promise<void> {
  await writeFile(zipPath, makeZip(entries))
}

/** 失败后目标目录必须完全不存在：不允许「先写后删」留下半成品。 */
async function expectNoOutput(): Promise<void> {
  await expect(stat(dest)).rejects.toMatchObject({ code: 'ENOENT' })
}

describe('zip 安全解压（S4 红线）', () => {
  it('正常包按条目落盘，目录条目不进 files', async () => {
    await writeZip([
      { name: 'model/', data: '' },
      { name: 'model/portrait.png', data: PNG },
      { name: 'model/model.json', data: '{"version":3}' }
    ])

    const result = await extractZipSafely(zipPath, dest)

    expect(result.files).toEqual(['model/portrait.png', 'model/model.json'])
    expect(result.maxDepth).toBe(1)
    expect(await readFile(join(dest, 'model/model.json'), 'utf8')).toBe('{"version":3}')
    expect(await readFile(join(dest, 'model/portrait.png'))).toEqual(PNG)
  })

  it('扩展名大小写不敏感：A.PNG 正常放行', async () => {
    await writeZip([{ name: 'A.PNG', data: PNG }])

    const result = await extractZipSafely(zipPath, dest)

    expect(result.files).toEqual(['A.PNG'])
  })

  it('条目数超过上限：拒绝且磁盘无输出', async () => {
    const entries: FixtureEntry[] = Array.from({ length: 6 }, (_, index) => ({
      name: `f${index}.png`,
      data: 'x'
    }))
    await writeZip(entries)

    await expect(extractZipSafely(zipPath, dest, { maxEntries: 5 })).rejects.toMatchObject({
      code: ErrorCode.ZIP_BOMB
    })
    await expectNoOutput()
  })

  it('伪造的未压缩大小不作数：按实际解压字节中途停', async () => {
    const payload = Buffer.alloc(2 * 1024 * 1024)
    await writeZip([
      { name: 'bomb.png', data: payload, method: 8, fakeUncompressedSize: 1024 }
    ])

    let caught: PetError | undefined
    try {
      await extractZipSafely(zipPath, dest, { maxTotalBytes: 100 * 1024 })
    } catch (error) {
      caught = error as PetError
    }

    expect(caught).toBeInstanceOf(Error)
    expect(caught?.code).toBe(ErrorCode.ZIP_BOMB)

    const details = caught?.details as { bytes: number }
    expect(details.bytes).toBeGreaterThan(100 * 1024)
    expect(details.bytes).toBeLessThan(payload.length)
    await expectNoOutput()
  })

  it('嵌套 zip 计入深度：第 4 层被拒', async () => {
    const level4 = makeZip([{ name: 'leaf.png', data: PNG }])
    const level3 = makeZip([{ name: 'l4.zip', data: level4 }])
    const level2 = makeZip([{ name: 'l3.zip', data: level3 }])
    const level1 = makeZip([{ name: 'l2.zip', data: level2 }])
    await writeFile(zipPath, makeZip([{ name: 'l1.zip', data: level1 }]))

    await expect(extractZipSafely(zipPath, dest)).rejects.toMatchObject({
      code: ErrorCode.ZIP_BOMB
    })
    await expectNoOutput()
  })

  it('嵌套 3 层以内正常解压', async () => {
    const inner = makeZip([{ name: 'leaf.png', data: PNG }])
    const outer = makeZip([{ name: 'inner.zip', data: inner }])
    await writeFile(zipPath, makeZip([{ name: 'model.zip', data: outer }]))

    const result = await extractZipSafely(zipPath, dest)

    expect(result.files).toEqual(['model/inner/leaf.png'])
    expect(result.maxDepth).toBe(3)
  })

  it('../ 条目被拒且磁盘无输出', async () => {
    await writeZip([{ name: '../evil.txt', data: 'x' }])

    await expect(extractZipSafely(zipPath, dest)).rejects.toMatchObject({
      code: ErrorCode.PATH_TRAVERSAL
    })
    await expectNoOutput()
  })

  it('绝对路径条目被拒且磁盘无输出', async () => {
    await writeZip([{ name: 'C:/evil.txt', data: 'x' }])

    await expect(extractZipSafely(zipPath, dest)).rejects.toMatchObject({
      code: ErrorCode.PATH_TRAVERSAL
    })
    await expectNoOutput()
  })

  it('最终落盘名带 .js 被拒，外层包名不影响判断', async () => {
    await writeZip([{ name: 'model/evil.js', data: 'alert(1)' }])

    await expect(extractZipSafely(zipPath, dest)).rejects.toMatchObject({
      code: ErrorCode.ASSET_FORBIDDEN_TYPE
    })
    await expectNoOutput()
  })

  it('SVG 即使大小写变化也按危险类型拒绝', async () => {
    await writeZip([{ name: 'model/ICON.SVG', data: '<svg/>' }])

    await expect(extractZipSafely(zipPath, dest)).rejects.toMatchObject({
      code: ErrorCode.ASSET_FORBIDDEN_TYPE
    })
    await expectNoOutput()
  })

  it('空包解压结果为空，不算失败', async () => {
    await writeZip([])

    const result = await extractZipSafely(zipPath, dest)

    expect(result.files).toEqual([])
    expect(result.entryCount).toBe(0)
  })

  it('加密位：显式拒绝，不静默放过', async () => {
    await writeZip([{ name: 'a.png', data: PNG, flags: 0x0001 }])

    await expect(extractZipSafely(zipPath, dest)).rejects.toMatchObject({
      code: ErrorCode.NOT_SUPPORTED
    })
    await expectNoOutput()
  })

  it('Zip64 标志：显式拒绝', async () => {
    const zip = makeZip([{ name: 'a.png', data: PNG }])
    const patched = Buffer.from(zip)
    patched.writeUInt32LE(0xffffffff, patched.length - 22 + 16)

    await writeFile(zipPath, patched)

    await expect(extractZipSafely(zipPath, dest)).rejects.toMatchObject({
      code: ErrorCode.NOT_SUPPORTED
    })
    await expectNoOutput()
  })

  it('分卷压缩包：显式拒绝', async () => {
    const zip = makeZip([{ name: 'a.png', data: PNG }])
    const patched = Buffer.from(zip)
    patched.writeUInt16LE(1, patched.length - 22 + 4)

    await writeFile(zipPath, patched)

    await expect(extractZipSafely(zipPath, dest)).rejects.toMatchObject({
      code: ErrorCode.NOT_SUPPORTED
    })
    await expectNoOutput()
  })

  it('中央目录条目数与声明不一致：拒绝，不当空包成功', async () => {
    const zip = makeZip([{ name: 'a.png', data: PNG }])
    const patched = Buffer.from(zip)
    patched.writeUInt16LE(99, patched.length - 22 + 10)

    await writeFile(zipPath, patched)

    await expect(extractZipSafely(zipPath, dest)).rejects.toMatchObject({
      code: ErrorCode.ZIP_BOMB
    })
    await expectNoOutput()
  })

  it('CRC 不一致：解压后校验拦截', async () => {
    await writeZip([{ name: 'a.png', data: PNG, fakeCrc: 1234 }])

    await expect(extractZipSafely(zipPath, dest)).rejects.toMatchObject({
      code: ErrorCode.ZIP_BOMB
    })
    await expectNoOutput()
  })

  it('本地头与中央目录的压缩方式不一致：拒绝', async () => {
    await writeZip([{ name: 'a.png', data: PNG, localMethod: 8 }])

    await expect(extractZipSafely(zipPath, dest)).rejects.toMatchObject({
      code: ErrorCode.ZIP_BOMB
    })
    await expectNoOutput()
  })

  it('本地头文件名与中央目录不一致：拒绝', async () => {
    await writeZip([{ name: 'a.png', data: PNG, localName: 'b.png' }])

    await expect(extractZipSafely(zipPath, dest)).rejects.toMatchObject({
      code: ErrorCode.ZIP_BOMB
    })
    await expectNoOutput()
  })

  it('重复条目名：先校验后落盘，同名覆盖绕不过去', async () => {
    await writeZip([
      { name: 'a.png', data: PNG },
      { name: 'a.png', data: 'alert(1)' }
    ])

    await expect(extractZipSafely(zipPath, dest)).rejects.toMatchObject({
      code: ErrorCode.ZIP_BOMB
    })
    await expectNoOutput()
  })

  it('大小写重复条目名同样拒绝（Windows 会互相覆盖）', async () => {
    await writeZip([
      { name: 'A.png', data: PNG },
      { name: 'a.png', data: 'alert(1)' }
    ])

    await expect(extractZipSafely(zipPath, dest)).rejects.toMatchObject({
      code: ErrorCode.ZIP_BOMB
    })
    await expectNoOutput()
  })

  it('目标目录已有文件：拒绝解压且原文件一字不动', async () => {
    await mkdir(dest, { recursive: true })
    await writeFile(join(dest, 'keep.png'), 'user-own')

    await writeZip([{ name: 'new.png', data: PNG }])

    await expect(extractZipSafely(zipPath, dest)).rejects.toMatchObject({
      code: ErrorCode.INVALID_ARGUMENT
    })

    expect(await readdir(dest)).toEqual(['keep.png'])
    expect(await readFile(join(dest, 'keep.png'), 'utf8')).toBe('user-own')
  })

  it('中途失败不碰目标目录，也不在父目录留下 staging', async () => {
    const level4 = makeZip([{ name: 'leaf.png', data: PNG }])
    const level3 = makeZip([{ name: 'l4.zip', data: level4 }])
    const level2 = makeZip([{ name: 'l3.zip', data: level3 }])
    const level1 = makeZip([{ name: 'l2.zip', data: level2 }])
    await writeFile(zipPath, makeZip([{ name: 'l1.zip', data: level1 }]))

    await expect(extractZipSafely(zipPath, dest)).rejects.toMatchObject({
      code: ErrorCode.ZIP_BOMB
    })
    await expectNoOutput()

    const leftovers = (await readdir(root)).filter((name) => name.startsWith('.extract-'))
    expect(leftovers).toEqual([])
  })

  it('解压成功后只留目标目录，staging 已消费', async () => {
    await writeZip([{ name: 'model/', data: '' }, { name: 'model/a.png', data: PNG }])

    await extractZipSafely(zipPath, dest)

    expect((await readdir(root)).sort()).toEqual(['out', 'upload.zip'])
  })

  it('五个拒绝码两两不等，且都能通过派生白名单校验', () => {
    const codes = [
      ErrorCode.ASSET_INVALID_MAGIC,
      ErrorCode.MIME_MISMATCH,
      ErrorCode.PATH_TRAVERSAL,
      ErrorCode.ZIP_BOMB,
      ErrorCode.ASSET_FORBIDDEN_TYPE
    ]

    expect(new Set(codes).size).toBe(codes.length)
    for (const code of codes) {
      expect(() => assertPersistableCode(code)).not.toThrow()
    }
  })
})
