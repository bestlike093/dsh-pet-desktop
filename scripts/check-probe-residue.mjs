// 探针残留守卫。
//
// 2026-10-28 真出过一次：调试用的探针文件删了报告，文件本身还在。
// 这类残留不会立刻爆，但会跟着提交进仓库，之后谁都说不清它是干什么的。
//
// 规则只认明确标记 `__probe__`，不做宽泛的 probe 匹配 ——
// `probe:heap`、`pet-probe` 都是合法名字，误伤会让守卫自己先被绕过。
//
// 本脚本不识别任何 disable / allow 注释。

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const SELF = 'scripts/check-probe-residue.mjs'
// 构建产物与导出暂存区不参与判定：它们整份拷贝源码，留着上一轮的守卫脚本。
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'dist-public',
  'tmp',
  '.git',
  '.vite',
  'coverage'
])
const SKIP_FILES = new Set([SELF])

const NAME_PATTERN = /__probe__|probe-report|probe-residue/i
const CONTENT_PATTERN = /__probe__/
// 内容检查只覆盖代码与配置。文档里会引用这条规则本身，扫文档会把它自己判失败。
const TEXT_EXT = /\.(ts|tsx|js|mjs|cjs|json|yml|yaml|ps1|cmd)$/i

const hits = []

function walk(dir) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }

  for (const entry of entries) {
    const absolute = join(dir, entry.name)
    const rel = relative(root, absolute).split('\\').join('/')

    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      walk(absolute)
      continue
    }

    if (!entry.isFile()) continue
    if (SKIP_FILES.has(rel)) continue

    if (NAME_PATTERN.test(entry.name)) {
      hits.push(`${rel}（文件名）`)
      continue
    }

    if (!TEXT_EXT.test(entry.name)) continue
    if (statSync(absolute).size > 2 * 1024 * 1024) continue

    let text
    try {
      text = readFileSync(absolute, 'utf8')
    } catch {
      continue
    }
    if (CONTENT_PATTERN.test(text)) hits.push(`${rel}（内容含 __probe__）`)
  }
}

walk(root)

if (hits.length > 0) {
  console.log(`FAIL 发现 ${hits.length} 处探针残留：`)
  for (const hit of hits) console.log(`  - ${hit}`)
  console.log('删除残留，或把合法用途改名后再跑。')
  console.log('PROBE_RESIDUE_FAILED')
  process.exit(1)
}

console.log('PROBE_RESIDUE_OK 未发现 __probe__ 类残留')
