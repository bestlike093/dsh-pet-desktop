import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** 依赖方向契约：值是该包允许依赖的 workspace 包。 */
export const ALLOWED_WORKSPACE_DEPS = {
  'packages/shared': [],
  'packages/core': ['@pet/shared'],
  'packages/vault': ['@pet/shared'],
  'packages/memory': ['@pet/shared'],
  'apps/desktop': ['@pet/shared', '@pet/core', '@pet/vault']
}

const WORKSPACE_PREFIX = '@pet/'

function dependencyNames(manifest) {
  return [
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {})
  ]
}

/**
 * 检查依赖方向与运行时零依赖。
 * manifests 的键必须是 ALLOWED_WORKSPACE_DEPS 里的包目录。
 */
export function checkDependencies(manifests) {
  const violations = []
  for (const [path, allowed] of Object.entries(ALLOWED_WORKSPACE_DEPS)) {
    const manifest = manifests[path]
    if (manifest === undefined) {
      violations.push(`${path}: 缺少 package.json`)
      continue
    }

    for (const name of dependencyNames(manifest)) {
      if (name.startsWith(WORKSPACE_PREFIX)) {
        if (!allowed.includes(name)) {
          violations.push(`${path}: 不允许依赖 ${name}`)
        }
      } else {
        violations.push(`${path}: 出现了非 workspace 运行时依赖 ${name}`)
      }
    }

    for (const name of allowed) {
      if (!dependencyNames(manifest).includes(name)) {
        violations.push(`${path}: 缺少声明的内部依赖 ${name}`)
      }
    }
  }
  return { ok: violations.length === 0, violations }
}

/** 递归统计目录体积，返回总字节、文件数与最大单文件。 */
export function walkSize(dir) {
  let bytes = 0
  let files = 0
  let largest = { path: '', bytes: 0 }
  const stack = [dir]

  while (stack.length > 0) {
    const current = stack.pop()
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(full)
      } else if (entry.isFile()) {
        let size = 0
        try {
          size = statSync(full).size
        } catch {
          continue
        }
        bytes += size
        files += 1
        if (size > largest.bytes) largest = { path: full, bytes: size }
      }
    }
  }

  return { bytes, files, largest }
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`
}
