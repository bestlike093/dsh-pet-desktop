// 写死色值门禁（阶段 0 基线版）。
//
// 只看 renderer 下的样式与页面。dist / node_modules / dist-pkg 都是产物，不扫。
//
// 判据分两类：
//   - token 定义（`--xxx: #abc`）：允许。主题就该在这里写三套值。
//   - 裸用（选择器里直接写 #fff、内联 style、meta theme-color）：待清理。
//
// 默认基线模式，只报数字；后续阶段收紧时加 --strict。

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const RENDERER = join(root, 'apps/desktop/electron/renderer')
const strict = process.argv.includes('--strict')

const HEX = /#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/g
const TOKEN_DEF = /^\s*--[\w-]+\s*:/

const files = readdirSync(RENDERER).filter((name) => /\.(css|html)$/i.test(name))

let tokenDefinitions = 0
let bareUses = 0
const perFile = []
const samples = []

for (const name of files.sort()) {
  const absolute = join(RENDERER, name)
  if (!statSync(absolute).isFile()) continue
  const rel = relative(root, absolute).split('\\').join('/')
  const text = readFileSync(absolute, 'utf8')
  const lines = text.split(/\r?\n/)

  let fileToken = 0
  let fileBare = 0

  lines.forEach((line, index) => {
    const matches = line.match(HEX)
    if (matches === null) return
    if (TOKEN_DEF.test(line)) {
      fileToken += matches.length
      return
    }
    fileBare += matches.length
    if (samples.length < 60) {
      samples.push(`${rel}:${index + 1} ${line.trim().slice(0, 90)}`)
    }
  })

  tokenDefinitions += fileToken
  bareUses += fileBare
  if (fileToken > 0 || fileBare > 0) {
    perFile.push({ rel, token: fileToken, bare: fileBare })
  }
}

console.log('=== 写死色值基线 ===')
console.log(`扫描 ${files.length} 个 css/html 文件`)
console.log(`token 定义 ${tokenDefinitions} 处，裸用 ${bareUses} 处`)
console.log('按文件：')
for (const item of perFile) {
  console.log(`  - ${item.rel}  token ${item.token} / 裸用 ${item.bare}`)
}

if (samples.length > 0) {
  console.log('\n裸用样例（最多 60 条）：')
  for (const sample of samples) console.log(`  - ${sample}`)
}

console.log(`\nHEX_COLORS_BASELINE 裸用=${bareUses} token定义=${tokenDefinitions}`)

if (strict && bareUses > 0) {
  console.log('HEX_COLORS_FAILED')
  process.exit(1)
}

console.log(strict ? 'HEX_COLORS_STRICT_OK（硬门禁，必须为 0）' : 'HEX_COLORS_OK（基线模式，未判定失败）')
