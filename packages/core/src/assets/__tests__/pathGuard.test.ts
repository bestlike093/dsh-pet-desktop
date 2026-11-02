import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ErrorCode, PetError } from '@pet/shared'
import {
  assertInsideRoot,
  assertNotSymlink,
  isInsideRoot,
  isTempPath,
  normalizeRoot
} from '../pathGuard.js'

let root = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-path-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function codeOf(fn: () => unknown): ErrorCode | undefined {
  try {
    fn()
  } catch (error) {
    return (error as PetError).code
  }
  return undefined
}

describe('路径守卫（S4 路径穿越）', () => {
  it('同族目录名不能绕过：assets-evil 不在 assets 内', () => {
    const assets = join(root, 'assets')
    const sibling = join(root, 'assets-evil', 'x.js')

    expect(isInsideRoot(assets, sibling)).toBe(false)
    expect(codeOf(() => assertInsideRoot(assets, sibling))).toBe(ErrorCode.PATH_TRAVERSAL)
  })

  it('根目录自身允许，子路径允许', () => {
    const assets = join(root, 'assets')

    expect(isInsideRoot(assets, assets)).toBe(true)
    expect(isInsideRoot(assets, join(assets, 'model.zip'))).toBe(true)
  })

  it('.. 归一后越出根目录会被拒', () => {
    const assets = join(root, 'assets')

    expect(codeOf(() => assertInsideRoot(assets, join(assets, '..', 'evil.js')))).toBe(
      ErrorCode.PATH_TRAVERSAL
    )
  })

  it('尾部斜杠先归一，不会拼出双分隔符', () => {
    const normalized = normalizeRoot(join(root, 'assets') + '/')

    expect(normalized.endsWith('/')).toBe(false)
    expect(isInsideRoot(normalized, join(normalized, 'a.png'))).toBe(true)
  })

  it('.tmp 内的路径被识别为临时资源', () => {
    const assets = join(root, 'assets')

    expect(isTempPath(assets, join(assets, '.tmp', 'abc.png'))).toBe(true)
    expect(isTempPath(assets, join(assets, 'image', 'abc.png'))).toBe(false)
  })

  it('符号链接被拒；平台不允许创建时跳过', async () => {
    const assets = join(root, 'assets')
    const outside = join(root, 'outside')
    await mkdir(assets, { recursive: true })
    await mkdir(outside, { recursive: true })

    const link = join(assets, 'link')
    try {
      await symlink(outside, link, 'junction')
    } catch {
      return
    }

    await expect(assertNotSymlink(link)).rejects.toBeInstanceOf(PetError)
  })

  it('不存在的路径不算符号链接', async () => {
    await expect(assertNotSymlink(join(root, 'missing.png'))).resolves.toBeUndefined()
  })
})
