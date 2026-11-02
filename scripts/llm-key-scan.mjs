// 发布卡点 T12：配置文件里不得出现明文 key 字段。
// 只扫配置类文件，不扫源码与测试（测试里的 sk-test-* 是假值）。
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, extname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCAN_DIRS = ['packages', 'apps', 'scripts']
const CONFIG_EXT = new Set(['.json', '.yaml', '.yml', '.toml', '.ini', '.env'])
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'coverage'])
const KEY_PATTERN = /["']?(api[_-]?key|llmApiKey|secretKey)["']?\s*[:=]\s*["'][^"']{8,}["']/i

const hits = []

function walk(dir) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }

  for (const entry of entries) {
    const full = join(dir, entry)
    const stat = statSync(full)

    if (stat.isDirectory()) {
      if (!SKIP_DIRS.has(entry)) walk(full)
      continue
    }

    if (!CONFIG_EXT.has(extname(entry).toLowerCase())) continue

    const lines = readFileSync(full, 'utf8').split(/\r?\n/)
    lines.forEach((text, index) => {
      if (KEY_PATTERN.test(text)) {
        hits.push(`${relative(root, full)}:${index + 1}: ${text.trim()}`)
      }
    })
  }
}

for (const dir of SCAN_DIRS) walk(join(root, dir))

if (hits.length === 0) {
  console.log('PASS 配置文件明文 key 字段 0 命中')
  process.exit(0)
}

for (const hit of hits) console.log(`FAIL ${hit}`)
process.exit(1)
