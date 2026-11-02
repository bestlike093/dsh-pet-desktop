import { ALL_PERMISSIONS, ErrorCode, PetError } from '@pet/shared'
import type { Permission } from '@pet/shared'

export interface PetalManifest {
  readonly id: string
  readonly name: string
  readonly version: string
  /** 相对模块根目录的入口文件，只允许 .js / .mjs */
  readonly entry: string
  readonly permissions: readonly Permission[]
  readonly minHostVersion?: string
}

export type ManifestResult =
  | { readonly ok: true; readonly manifest: PetalManifest }
  | { readonly ok: false; readonly error: PetError }

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{1,63}$/
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9a-z.-]+)?$/i
const ENTRY_PATTERN = /^[a-zA-Z0-9._/-]+\.(?:js|mjs)$/
const ALLOWED = new Set<string>(ALL_PERMISSIONS)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function fail(message: string): ManifestResult {
  return { ok: false, error: new PetError(ErrorCode.LOAD_FAILED, message) }
}

/**
 * 清单校验：身份、版本、入口路径、权限白名单四项全过才算合法。
 * 未知字段忽略，便于旧版宿主读取新版清单。
 */
export function parsePetalManifest(raw: unknown): ManifestResult {
  if (!isRecord(raw)) return fail('模块清单必须是对象')

  const id = raw['id']
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    return fail('模块 id 不合法（小写字母/数字/._-，2-64 位）')
  }

  const name = raw['name']
  if (typeof name !== 'string' || name.trim().length === 0 || name.length > 64) {
    return fail('模块 name 不合法')
  }

  const version = raw['version']
  if (typeof version !== 'string' || !VERSION_PATTERN.test(version)) {
    return fail('模块 version 必须是 semver')
  }

  const entry = raw['entry']
  if (typeof entry !== 'string' || !ENTRY_PATTERN.test(entry) || entry.includes('..')) {
    return fail('模块 entry 必须是模块根目录内的 .js/.mjs 相对路径')
  }

  const permissions = raw['permissions']
  if (!Array.isArray(permissions)) return fail('模块 permissions 必须是数组')
  const normalized: Permission[] = []
  for (const permission of permissions) {
    if (typeof permission !== 'string' || !ALLOWED.has(permission)) {
      return fail(`未知权限：${String(permission)}`)
    }
    if (!normalized.includes(permission as Permission)) normalized.push(permission as Permission)
  }

  const minHostVersion = raw['minHostVersion']
  if (minHostVersion !== undefined && typeof minHostVersion !== 'string') {
    return fail('minHostVersion 必须是字符串')
  }

  return {
    ok: true,
    manifest: {
      id,
      name: name.trim(),
      version,
      entry,
      permissions: normalized,
      ...(minHostVersion === undefined ? {} : { minHostVersion })
    }
  }
}
