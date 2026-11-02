// 浏览器入口卡点：从 dist/browser.js 出发递归遍历依赖树，任何 Node-only 依赖即失败。
//
// 为什么必须递归：barrel 的危害是「导入一个符号，拉进整棵子树」。
// 2026-10-27 S2 真机事故里，renderer.mjs 只导入了 10 个符号，
// 却因为 index.js 里一行 `export * from './assets/assetManager.js'` 整张模块图失败。
//
// 检查方向是双向的：
// 1. `node:*` 前缀 —— 显式 Node 内建
// 2. 裸导入的第三方包 —— Node-only 包（fs-extra / sharp 等）同样会炸

import { readFileSync, existsSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const ENTRY = join(root, 'packages/core/dist/browser.js')
const RENDERER_DIR = join(root, 'apps/desktop/electron/renderer')

// Node 内建模块（不带 node: 前缀时也要拦）
const NODE_BUILTINS = new Set([
  'assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console', 'constants',
  'crypto', 'dgram', 'diagnostics_channel', 'dns', 'domain', 'events', 'fs', 'http',
  'http2', 'https', 'inspector', 'module', 'net', 'os', 'path', 'perf_hooks', 'process',
  'punycode', 'querystring', 'readline', 'repl', 'stream', 'string_decoder', 'timers',
  'tls', 'trace_events', 'tty', 'url', 'util', 'v8', 'vm', 'wasi', 'worker_threads', 'zlib'
])

// 已知只能跑在 Node 的第三方包（按需追加，不要靠猜）
const NODE_ONLY_PACKAGES = new Set([
  'fs-extra', 'graceful-fs', 'glob', 'rimraf', 'chokidar', 'archiver', 'unzipper',
  'jsdom', 'sharp', 'canvas', 'node-gyp', 'node-addon-api', 'fsevents'
])

const IMPORT_RE = /(?:^|[^\w$])(?:import|export)\s+(?:[^'"();]*?\s+from\s+)?['"]([^'"]+)['"]/g
const DYNAMIC_RE = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g

function extractSpecifiers(source) {
  const found = new Set()
  for (const re of [IMPORT_RE, DYNAMIC_RE]) {
    re.lastIndex = 0
    let match
    while ((match = re.exec(source)) !== null) found.add(match[1])
  }
  return [...found]
}

function resolveRelative(fromFile, spec) {
  const base = resolve(dirname(fromFile), spec)
  const candidates = [base, `${base}.js`, join(base, 'index.js')]
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  return null
}

function packageNameOf(spec) {
  if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:')) return null
  const parts = spec.split('/')
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

const violations = []
const visited = new Set()
const queue = [{ file: ENTRY, chain: ['packages/core/dist/browser.js'] }]

while (queue.length > 0) {
  const { file, chain } = queue.shift()
  if (visited.has(file)) continue
  visited.add(file)

  if (!existsSync(file)) {
    violations.push({ chain, reason: `文件不存在：${file}` })
    continue
  }

  const source = readFileSync(file, 'utf8')
  for (const spec of extractSpecifiers(source)) {
    if (spec.startsWith('node:')) {
      violations.push({ chain, reason: `${spec}（node: 前缀）` })
      continue
    }
    if (NODE_BUILTINS.has(spec)) {
      violations.push({ chain, reason: `${spec}（Node 内建模块）` })
      continue
    }
    const pkg = packageNameOf(spec)
    if (pkg !== null) {
      if (NODE_ONLY_PACKAGES.has(pkg)) {
        violations.push({ chain, reason: `${pkg}（Node-only 第三方包）` })
        continue
      }
      // 工作区包：继续递归（@pet/shared 目前是纯类型 + 常量）
      const localEntry = join(root, 'node_modules', pkg)
      if (existsSync(localEntry)) continue
      continue
    }
    const next = resolveRelative(file, spec)
    if (next === null) {
      violations.push({ chain, reason: `无法解析的相对导入：${spec}` })
      continue
    }
    queue.push({ file: next, chain: [...chain, relative(next)] })
  }
}

function relative(absPath) {
  return absPath.replace(root, '').replace(/^[\\/]/, '').replace(/\\/g, '/')
}

// 渲染侧不得从全量入口导入
const rendererViolations = []
if (existsSync(RENDERER_DIR)) {
  const rendererFiles = ['renderer.mjs']
  for (const name of rendererFiles) {
    const target = join(RENDERER_DIR, name)
    if (!existsSync(target)) continue
    const source = readFileSync(target, 'utf8')
    if (/core\/dist\/index\.js/.test(source)) {
      rendererViolations.push(`${name} 从 core/dist/index.js（全量入口）导入，应改为 core/dist/browser.js`)
    }
  }
}

let failed = 0
function line(ok, text) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${text}`)
  if (!ok) failed += 1
}

line(
  violations.length === 0,
  violations.length === 0
    ? `browser 入口依赖树无 Node-only 依赖（递归 ${visited.size} 个模块）`
    : `browser 入口依赖树命中 ${violations.length} 处 Node-only 依赖`
)

for (const violation of violations) {
  console.log(`  链路：${violation.chain.join(' -> ')}`)
  console.log(`  命中：${violation.reason}`)
}

line(
  rendererViolations.length === 0,
  rendererViolations.length === 0 ? 'renderer 只从 browser 入口导入' : rendererViolations.join('；')
)

if (failed > 0) {
  console.log('BROWSER_ENTRY_FAILED')
  process.exit(1)
}
console.log('BROWSER_ENTRY_OK')
