#!/usr/bin/env node
/**
 * 公共契约快照。
 *
 * `packages/shared/src/contracts/**` 是跨包契约面：签名被无意改动时，下游往往要等到
 * typecheck 报错或运行时才炸。这个脚本把每个 `export interface` / `export type`
 * 规范化成一行，写进 `packages/shared/contracts.snapshot.json`，签名一漂移就失败。
 *
 *   node scripts/contract-snapshot.mjs           校验，不一致 exit 1
 *   node scripts/contract-snapshot.mjs --update  有意变更后重新生成
 *
 * 只比结构：注释、空白、换行不参与比较。实现体（export const / function）不记录。
 * 提取器在 scripts/lib/contract-extract.mjs，自测见 scripts/contract-guard-smoke.mjs。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractDeclarations } from './lib/contract-extract.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

const CONTRACTS_DIR = path.join(ROOT, 'packages/shared/src/contracts')
const SNAPSHOT_PATH = path.join(ROOT, 'packages/shared/contracts.snapshot.json')
const UPDATE = process.argv.includes('--update')

function collect() {
  if (!fs.existsSync(CONTRACTS_DIR)) {
    console.error(`CONTRACT_SNAPSHOT_FAILED 找不到目录 ${CONTRACTS_DIR}`)
    process.exit(1)
  }

  const files = fs
    .readdirSync(CONTRACTS_DIR)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .sort()

  const declarations = {}
  const seenIn = new Map()

  for (const file of files) {
    const source = fs.readFileSync(path.join(CONTRACTS_DIR, file), 'utf8')
    for (const [name, signature] of extractDeclarations(source)) {
      if (seenIn.has(name)) {
        console.error(
          `CONTRACT_SNAPSHOT_FAILED 契约名重复：${name} 同时出现在 ${seenIn.get(name)} 和 ${file}`
        )
        process.exit(1)
      }
      seenIn.set(name, file)
      declarations[name] = signature
    }
  }

  return { files, declarations }
}

function serialize(files, declarations) {
  const sorted = {}
  for (const name of Object.keys(declarations).sort()) sorted[name] = declarations[name]
  return `${JSON.stringify({ files, contracts: sorted }, null, 2)}\n`
}

const { files, declarations } = collect()
const rendered = serialize(files, declarations)

if (UPDATE) {
  fs.writeFileSync(SNAPSHOT_PATH, rendered, 'utf8')
  const count = Object.keys(declarations).length
  console.log(`CONTRACT_SNAPSHOT_WRITTEN ${count} 个契约 -> ${path.relative(ROOT, SNAPSHOT_PATH)}`)
  process.exit(0)
}

if (!fs.existsSync(SNAPSHOT_PATH)) {
  console.error('CONTRACT_SNAPSHOT_FAILED 快照缺失，先运行：node scripts/contract-snapshot.mjs --update')
  process.exit(1)
}

const previous = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8'))
const before = previous.contracts ?? {}
const names = new Set([...Object.keys(before), ...Object.keys(declarations)])

const added = []
const removed = []
const changed = []

for (const name of [...names].sort()) {
  if (!(name in before)) added.push(name)
  else if (!(name in declarations)) removed.push(name)
  else if (before[name] !== declarations[name]) changed.push(name)
}

if (added.length === 0 && removed.length === 0 && changed.length === 0) {
  console.log(`CONTRACT_SNAPSHOT_OK ${Object.keys(declarations).length} 个契约未漂移`)
  process.exit(0)
}

console.error('CONTRACT_SNAPSHOT_FAILED 公共契约发生漂移：')
for (const name of added) console.error(`  + ${name}（新增）`)
for (const name of removed) console.error(`  - ${name}（删除）`)
for (const name of changed) {
  console.error(`  ~ ${name}（签名变更）`)
  console.error(`      旧：${before[name]}`)
  console.error(`      新：${declarations[name]}`)
}
console.error('')
console.error('确认这是有意变更后，重新生成快照并连同代码一起提交：')
console.error('  node scripts/contract-snapshot.mjs --update')
process.exit(1)
