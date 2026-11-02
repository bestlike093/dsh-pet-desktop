#!/usr/bin/env node
/**
 * 校验能力实据仍然成立（LESSONS 禁止项 26：实据不能只核对一次）。
 *
 * 读本机 dsh 安装包里的 api-catalog，取 SERVICE_API 的 key；
 * 再与 packages/core/src/host/capabilityEvidence.ts 里每个
 * `apiCatalogKey` 比对。任何一个 key 消失 → 非零退出。
 *
 * 安装包不在本机时只打印 SKIP：CI 没有 dsh，不能因此判失败。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const EVIDENCE_FILE = 'packages/core/src/host/capabilityEvidence.ts'
const API_CATALOG_ENTRY =
  'dsh/node_modules/@deepseek-ai/dsh-tool-cordis/lib/types/api-catalog.js'

function fail(message) {
  console.error(`API_CATALOG_FAIL ${message}`)
  process.exitCode = 1
}

function readEvidenceKeys() {
  const source = readFileSync(EVIDENCE_FILE, 'utf8')
  const keys = [...source.matchAll(/apiCatalogKey: '([^']+)'/g)].map((match) => match[1])
  return [...new Set(keys)]
}

function locateEntry(buffer) {
  if (buffer.length < 16) return undefined
  const headerSize = buffer.readUInt32LE(12)
  const dataStart = 16 + headerSize
  if (headerSize === 0 || dataStart > buffer.length) return undefined

  let tree
  try {
    const raw = buffer.subarray(16, dataStart).toString('utf8').replace(/\u0000+$/, '')
    tree = JSON.parse(raw)
  } catch {
    return undefined
  }

  let node = tree
  for (const part of API_CATALOG_ENTRY.split('/')) {
    node = node?.files?.[part]
    if (node === undefined) return undefined
  }

  if (node.unpacked === true) return undefined

  const offset = Number(node.offset)
  const size = Number(node.size)
  if (!Number.isFinite(offset) || !Number.isFinite(size)) return undefined
  return { offset: dataStart + offset, size }
}

function extractServiceApiKeys(text) {
  const start = text.indexOf('export const SERVICE_API = [')
  if (start === -1) return []

  const end = text.indexOf('\n];', start)
  const block = end === -1 ? text.slice(start) : text.slice(start, end)
  return [...block.matchAll(/^ {8}key: '([^']+)',$/gm)].map((match) => match[1])
}

function liveKeys() {
  const localAppData = process.env.LOCALAPPDATA
  const installDir =
    process.env.DSH_HOME ||
    (process.platform === 'win32' && localAppData
      ? join(localAppData, 'Programs', 'DeepSeek Harness')
      : undefined)

  if (!installDir) return { keys: undefined, reason: 'no install dir' }

  const asarPath = join(installDir, 'resources', 'app.asar')
  if (!existsSync(asarPath)) return { keys: undefined, reason: `missing ${asarPath}` }

  const buffer = readFileSync(asarPath)
  const entry = locateEntry(buffer)
  if (entry === undefined) return { keys: undefined, reason: 'api-catalog not in asar' }

  const keys = extractServiceApiKeys(buffer.subarray(entry.offset, entry.offset + entry.size).toString('utf8'))
  return { keys: keys.length > 0 ? keys : undefined, reason: 'api-catalog empty' }
}

if (process.argv.includes('--self-test')) {
  const text = [
    'export const SERVICE_API = [',
    "        key: 'llm',",
    "        key: 'sessions',",
    '];',
    'export const HARNESS_EVENTS = [',
    "        key: 'nope',",
    '];'
  ].join('\n')

  const keys = extractServiceApiKeys(text)
  if (keys.length !== 2 || keys[0] !== 'llm' || keys[1] !== 'sessions') {
    fail(`self-test 抽出 ${JSON.stringify(keys)}`)
  } else {
    console.log('API_CATALOG_SELF_TEST_OK')
  }
  process.exit()
}

const declared = readEvidenceKeys()
if (declared.length === 0) {
  fail(`没在 ${EVIDENCE_FILE} 里找到任何 apiCatalogKey`)
  process.exit()
}

const { keys, reason } = liveKeys()
if (keys === undefined) {
  console.log(`API_CATALOG_SKIP ${reason}`)
  process.exit()
}

const live = new Set(keys)
const missing = declared.filter((key) => !live.has(key))

if (missing.length > 0) {
  fail(`SERVICE_API 里已不存在：${missing.join(', ')}（安装包 ${keys.length} keys）`)
} else {
  console.log(`API_CATALOG_OK ${declared.length} keys 仍在 SERVICE_API 中（共 ${keys.length}）`)
}
