// i18n 覆盖门禁（阶段 0 基线版）。
//
// 两件事分开报，免得混成一个数字看不清责任：
//   1. 字典本身：ZH 与 EN 的 key 是否一一对应
//   2. 界面引用：HTML 里 data-i18n 指向的 key 是否存在
//   3. 中文残留：可见文本里还有没挂 data-i18n 的中文
//
// 默认是基线模式：只报数字，不判失败。B 批次的出口是「跑出基线」，
// 收紧成硬门禁放在后续阶段，届时用 --strict。
//
// 规则刻意保守：脚本自己、文档、注释都不扫；只扫 renderer 下的 HTML，
// 因为那才是用户真正看到的文案来源。

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const RENDERER = join(root, 'apps/desktop/electron/renderer')
const I18N_FILE = join(RENDERER, 'i18n.js')
const strict = process.argv.includes('--strict')

function readKeys(text, startLine, endLine) {
  const lines = text.split(/\r?\n/)
  const keys = new Set()
  for (let index = startLine; index < endLine; index += 1) {
    const match = /^\s*'([^']+)'\s*:/.exec(lines[index] ?? '')
    if (match) keys.add(match[1])
  }
  return keys
}

const i18nText = readFileSync(I18N_FILE, 'utf8')
// 按标记定位两个字典，不写死行号：以后加一行文案不会让整个统计错位。
const i18nLines = i18nText.split(/\r?\n/)
const zhStart = i18nLines.findIndex((line) => line.includes('const ZH = {'))
const enStart = i18nLines.findIndex((line) => line.includes('const EN = {'))
if (zhStart === -1 || enStart === -1) {
  console.error('I18N_COVERAGE_FAILED 找不到 const ZH / const EN')
  process.exit(1)
}
const dictEnd = i18nLines.findIndex((line, index) => index > enStart && /^\s*\}\s*$/.test(line))
const zhKeys = readKeys(i18nText, zhStart + 1, enStart)
const enKeys = readKeys(i18nText, enStart + 1, dictEnd === -1 ? i18nLines.length : dictEnd)

const zhMissingInEn = [...zhKeys].filter((key) => !enKeys.has(key))
const enMissingInZh = [...enKeys].filter((key) => !zhKeys.has(key))

/** 去掉 script / style / 注释，剩下的才是可见标记。 */
function stripNonVisible(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '')
}

const referenced = []
const uncovered = []

// 兜底页刻意不依赖 i18n.js：renderer 已经起不来时，字典也可能加载不了。
// 它的文案必须在无脚本、CSP default-src 'none' 下直接可读，中文残留门禁在这里豁免。
const SELF_CONTAINED_HTML = new Set(['fallback.html'])

const htmlFiles = readdirSync(RENDERER)
  .filter((name) => name.endsWith('.html'))
  .sort()

for (const name of htmlFiles) {
  const absolute = join(RENDERER, name)
  if (!statSync(absolute).isFile()) continue
  const rel = relative(root, absolute).split('\\').join('/')
  if (SELF_CONTAINED_HTML.has(name)) {
    console.log(`  SKIP ${rel}（自包含兜底页，不依赖 i18n）`)
    continue
  }
  const raw = readFileSync(absolute, 'utf8')
  const html = stripNonVisible(raw)
  const lines = html.split(/\r?\n/)

  lines.forEach((line, index) => {
    for (const match of line.matchAll(/data-i18n(?:-placeholder|-title)?="([^"]+)"/g)) {
      referenced.push({ file: rel, line: index + 1, key: match[1] })
    }
  })

  // 只看「开标签 + 紧跟的文本」这一种形态：它覆盖绝大多数行内文案，
  // 又不会把属性值里的中文误当成可见文本。
  const stripped = html.replace(/\n/g, '\n')
  for (const match of stripped.matchAll(
    /<([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>([^<]*[\u3400-\u9fff][^<]*)</g
  )) {
    const attrs = match[2] ?? ''
    if (/\bdata-i18n\b/.test(attrs)) continue
    const text = match[3].trim()
    if (text === '') continue
    const before = stripped.slice(0, match.index)
    const line = before.split('\n').length
    uncovered.push({ file: rel, line, text: text.slice(0, 60) })
  }

  // placeholder / title / aria-label 直接写中文，也算漏覆盖；
  // 但同标签挂了 data-i18n-* 的，文案已经可翻译，不算残留。
  for (const match of html.matchAll(/\b(placeholder|title|aria-label)="([^"]*[\u3400-\u9fff][^"]*)"/g)) {
    const tagStart = html.lastIndexOf('<', match.index)
    const tagEnd = html.indexOf('>', match.index)
    const tagText = html.slice(tagStart, tagEnd === -1 ? html.length : tagEnd)
    if (/\bdata-i18n(?:-placeholder|-title)?\b/.test(tagText)) continue
    const before = html.slice(0, match.index)
    const line = before.split('\n').length
    uncovered.push({ file: rel, line, text: `${match[1]}="${match[2].slice(0, 40)}"` })
  }
}

const missingKeys = referenced.filter((item) => !zhKeys.has(item.key))

console.log('=== i18n 字典 ===')
console.log(`ZH ${zhKeys.size} key，EN ${enKeys.size} key`)
console.log(`ZH 有 EN 缺 ${zhMissingInEn.length}，EN 有 ZH 缺 ${enMissingInZh.length}`)
for (const key of zhMissingInEn.slice(0, 20)) console.log(`  - EN 缺 ${key}`)
for (const key of enMissingInZh.slice(0, 20)) console.log(`  - ZH 缺 ${key}`)

console.log('\n=== 界面引用 ===')
console.log(`HTML ${htmlFiles.length} 个，data-i18n 引用 ${referenced.length} 处，缺 key ${missingKeys.length} 处`)
for (const item of missingKeys.slice(0, 30)) {
  console.log(`  - ${item.file}:${item.line} ${item.key}`)
}

console.log('\n=== 中文残留 ===')
console.log(`未挂 data-i18n 的可见中文 ${uncovered.length} 处`)
for (const item of process.argv.includes('--all') ? uncovered : uncovered.slice(0, 40)) {
  console.log(`  - ${item.file}:${item.line} ${item.text}`)
}

const total = zhMissingInEn.length + enMissingInZh.length + missingKeys.length + uncovered.length
console.log(
  `\nI18N_COVERAGE_BASELINE 缺失key=${missingKeys.length} 中文残留=${uncovered.length} 字典不对称=${zhMissingInEn.length + enMissingInZh.length}`
)

if (strict && total > 0) {
  console.log('I18N_COVERAGE_FAILED')
  process.exit(1)
}

console.log(strict ? 'I18N_COVERAGE_STRICT_OK（硬门禁，必须为 0）' : 'I18N_COVERAGE_OK（基线模式，未判定失败）')
