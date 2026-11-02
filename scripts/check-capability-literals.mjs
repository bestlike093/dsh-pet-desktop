// 能力名裸字面量卡点（③-d）。
//
// 为什么只扫三个上下文：范围一放宽就会误伤 `dialogueQueue` / `channel` / `settings`
// 里的同名字面量，最后只能靠注释豁免 —— 一条能被注释洗白的规则不是规则。
//
// 本脚本不识别任何 disable / allow 标记。要修就改代码。
//
// 规则：
// - 生产代码：`hostCapabilities` / `available` / `notApplicable` 数组、
//   `CAPABILITY_DEGRADE` / `HOST_CAPABILITY_FORM` 对象里，不得出现能力名的裸字面量；
// - 测试代码：同样位置允许字面量，但数组必须带类型标注（`as const` / `as HostCapability[]`），
//   否则读的人无法判断这是宿主能力而不是同名通道。

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const DEFINITION = join(root, 'packages/shared/src/types/module.ts')
const SCAN_ROOTS = [
  join(root, 'packages/shared/src'),
  join(root, 'packages/core/src'),
  join(root, 'apps/desktop')
]
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.vite', 'coverage'])
const SCAN_EXT = /\.(ts|tsx|mjs)$/

/**
 * 能力名从唯一真源读取，不在脚本里复制一份。
 * 读不到就直接失败 —— 脚本静默失效比漏报更危险。
 */
function loadCapabilityNames() {
  const source = readFileSync(DEFINITION, 'utf8')
  const match = /export const HOST_CAPABILITY\s*=\s*\{([\s\S]*?)\}\s*as const/.exec(source)
  if (match === null) {
    console.log('FAIL 未能从 types/module.ts 读取 HOST_CAPABILITY 真源')
    console.log('CAPABILITY_LITERALS_FAILED')
    process.exit(1)
  }
  const names = new Set()
  const keyRe = /^\s*([A-Za-z][A-Za-z0-9]*)\s*:/gm
  let entry
  while ((entry = keyRe.exec(match[1])) !== null) names.add(entry[1])
  if (names.size === 0) {
    console.log('FAIL HOST_CAPABILITY 解析为空，扫描无法进行')
    console.log('CAPABILITY_LITERALS_FAILED')
    process.exit(1)
  }
  return names
}

const CAPABILITIES = loadCapabilityNames()

const ARRAY_CONTEXT = /(hostCapabilities|available|notApplicable)\s*:\s*\[/
const OBJECT_CONTEXT = /(CAPABILITY_DEGRADE|HOST_CAPABILITY_FORM)\s*(?::[^=]+)?=\s*\{/

function isTestFile(file) {
  return /[\\/]__tests__[\\/]/.test(file) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(file)
}

function walk(dir, out) {
  if (!existsSync(dir)) return
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue
    const full = join(dir, name)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      walk(full, out)
    } else if (SCAN_EXT.test(name)) {
      out.push(full)
    }
  }
}

/** 从 `open` 位置起找到配对的闭合符号，返回区间与闭合行。 */
function balancedRegion(lines, startLine, startColumn, open, close) {
  let depth = 0
  let body = ''
  for (let line = startLine; line < lines.length; line += 1) {
    const text = lines[line]
    for (let column = line === startLine ? startColumn : 0; column < text.length; column += 1) {
      const ch = text[column]
      if (ch === open) {
        depth += 1
        if (depth === 1) continue
      } else if (ch === close) {
        depth -= 1
        if (depth === 0) return { body, endLine: line, endColumn: column }
      }
      if (depth > 0) body += ch
    }
    if (depth > 0) body += '\n'
  }
  return null
}

const violations = []

function record(file, line, message) {
  violations.push({ file: relative(root, file).replace(/\\/g, '/'), line: line + 1, message })
}

function scanArrayLiteral(file, lines, lineIndex, match, isTest) {
  const openColumn = lines[lineIndex].indexOf('[', match.index)
  const region = balancedRegion(lines, lineIndex, openColumn, '[', ']')
  if (region === null) {
    record(file, lineIndex, '数组未闭合，无法判定能力上下文')
    return
  }

  if (isTest) {
    // 测试里允许字面量（它们就是被测数据），但必须带类型标注，
    // 否则读的人无法判断这是宿主能力而不是同名通道。
    const tail = lines[region.endLine].slice(region.endColumn + 1)
    const nextLine = lines[region.endLine + 1] ?? ''
    if (!/\bas\b/.test(`${tail}\n${nextLine}`)) {
      record(
        file,
        region.endLine,
        `${match[1]} 数组缺少类型标注，补 \`as const satisfies readonly HostCapability[]\``
      )
    }
    return
  }

  const literalRe = /'([A-Za-z][A-Za-z0-9]*)'/g
  let literal
  while ((literal = literalRe.exec(region.body)) !== null) {
    if (!CAPABILITIES.has(literal[1])) continue
    record(file, lineIndex, `${match[1]} 里出现裸字面量 '${literal[1]}'，改用 HOST_CAPABILITY.${literal[1]}`)
  }
}

function scanObjectLiteral(file, lines, lineIndex, match) {
  const openColumn = lines[lineIndex].indexOf('{', match.index)
  const region = balancedRegion(lines, lineIndex, openColumn, '{', '}')
  if (region === null) {
    record(file, lineIndex, `${match[1]} 对象未闭合，无法判定能力上下文`)
    return
  }

  const keyRe = /^\s*([A-Za-z][A-Za-z0-9]*)\s*:/gm
  let key
  while ((key = keyRe.exec(region.body)) !== null) {
    if (!CAPABILITIES.has(key[1])) continue
    record(file, lineIndex, `${match[1]} 的 key \`${key[1]}\` 是裸能力名，改用 [HOST_CAPABILITY.${key[1]}]`)
  }
}

const files = []
for (const dir of SCAN_ROOTS) walk(dir, files)

for (const file of files) {
  const source = readFileSync(file, 'utf8')
  const lines = source.split(/\r?\n/)
  const isTest = isTestFile(file)
  const isDefinition = file === DEFINITION

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]

    // 真源本身的 HOST_CAPABILITY 块是定义处，不对自己报错。
    if (isDefinition && /export const HOST_CAPABILITY\s*=/.test(line)) continue

    const arrayMatch = ARRAY_CONTEXT.exec(line)
    if (arrayMatch !== null) {
      scanArrayLiteral(file, lines, index, arrayMatch, isTest)
      continue
    }

    const objectMatch = OBJECT_CONTEXT.exec(line)
    if (objectMatch !== null) {
      scanObjectLiteral(file, lines, index, objectMatch)
    }
  }
}

console.log(`扫描 ${files.length} 个文件，能力真源 ${CAPABILITIES.size} 项`)

for (const violation of violations) {
  console.log(`FAIL ${violation.file}:${violation.line} ${violation.message}`)
}

if (violations.length > 0) {
  console.log(`CAPABILITY_LITERALS_FAILED 命中 ${violations.length} 处`)
  process.exit(1)
}

console.log('CAPABILITY_LITERALS_OK')
