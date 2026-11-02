/**
 * 从 core.mjs 生成 core.cjs。
 *
 * 真源只保留一份 ESM；Cyrene 只能用 require，所以需要一份等价的 CJS 产物。
 * 转换只处理这个文件用到的两种语法（export const / export function），
 * 超出范围时直接失败，不生成半成品。
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const bundleDir = join(root, 'bundle', 'dyad-petal')
const srcPath = join(bundleDir, 'core.mjs')
const outPath = join(bundleDir, 'core.cjs')

const source = readFileSync(srcPath, 'utf8')

// 只允许这两类导出；出现别的形状说明真源超出了转换器能力，宁可失败。
const unexpected = source
  .split('\n')
  .filter((line) => line.startsWith('export ') && !/^export (const|function) /.test(line))

if (unexpected.length > 0) {
  console.error('FAIL 真源出现转换器不认识的导出：')
  for (const line of unexpected) console.error(`  ${line}`)
  process.exit(1)
}

const body = source
  .replace(/^\/\*\*[\s\S]*?\*\/\n+/, '')
  .replace(/^export (const|function) /gm, '$1 ')

const output = [
  "'use strict'",
  '',
  '/**',
  ' * 由 scripts/build-petal-core.mjs 从 core.mjs 生成，不要手改。',
  ' * 需要改动时改 core.mjs，然后跑 `pnpm petal:build`。',
  ' */',
  '',
  body.trimEnd(),
  '',
  'module.exports = { ID, VERSION, describe, greet, markHost, snapshot, core }',
  ''
].join('\n')

writeFileSync(outPath, output, 'utf8')
console.log(`PETAL_CORE_BUILT ${outPath}`)
