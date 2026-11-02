// 同步包清单门禁。
//
// 同步目录可能被 PET_SYNC_DIR 指到共享盘，白名单里的每一项都会离开本机。
// 这里静态读取 sync.mjs 的两个清单字面量，不与运行时共享代码，避免为了
// 一条门禁去依赖 packages/vault/dist 的构建产物。
//
// 断言三件事：
//   1. 白名单里不出现密钥、聊天历史、任务日志、记忆库、余额这类键；
//   2. 剔除路径必须至少两层（只有一层等于整块没同步，保护失效）；
//   3. 剔除路径的根节点必须在白名单内（否则这条规则永远不生效）。
//
// --self-test 会喂一份故意违规的清单，必须判红；门禁本身也要被门禁。

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const SYNC_FILE = join(root, 'apps', 'desktop', 'electron', 'sync.mjs')

/** 一旦进入同步白名单，就等于把本机数据带出机器的键名。 */
const FORBIDDEN = [
  { pattern: /vault-?keys?/i, why: '密钥环' },
  { pattern: /keys\.json/i, why: '密钥文件' },
  { pattern: /secret/i, why: '凭据' },
  { pattern: /passphrase/i, why: '备份口令' },
  { pattern: /^chat$|chat.?history|chatlog/i, why: '聊天历史' },
  { pattern: /^history$/i, why: '历史记录' },
  { pattern: /^tasks?$|task.?log|tasks\.log/i, why: '任务日志' },
  { pattern: /^memory$|memory\.bin/i, why: '记忆库' },
  { pattern: /^balance$/i, why: '余额状态' },
  { pattern: /refAudioPath|localUrl|baseUrl/i, why: '本机路径或内网地址' }
]

function arrayBlock(source, name) {
  const re = new RegExp(`export const ${name} = Object\\.freeze\\(\\[([\\s\\S]*?)\\]\\)`)
  const match = source.match(re)
  return match === null ? null : match[1]
}

function stringList(block) {
  return [...block.matchAll(/'([^']*)'/g)].map((item) => item[1])
}

function nestedPaths(block) {
  const paths = []
  const re = /Object\.freeze\(\[([^\]]*)\]\)/g
  // arrayBlock 的非贪婪截取会在内层数组的 `])` 处提前收尾，这里补回结尾再匹配
  const text = block.trimEnd().endsWith('])') ? block : `${block}])`
  let match
  while ((match = re.exec(text)) !== null) {
    paths.push(stringList(match[1]))
  }
  return paths
}

export function validateManifest(keys, redactedPaths) {
  const violations = []
  for (const key of keys) {
    for (const rule of FORBIDDEN) {
      if (rule.pattern.test(key)) violations.push(`同步白名单含 ${key}（${rule.why}）`)
    }
  }
  for (const path of redactedPaths) {
    const joined = path.join('.')
    if (path.length < 2) {
      violations.push(`剔除路径 ${joined || '(空)'} 深度不足 2，等于整块未同步`)
    }
    if (path.length > 0 && !keys.includes(path[0])) {
      violations.push(`剔除路径 ${joined} 的根节点不在白名单内，规则永不生效`)
    }
  }
  return violations
}

function selfTest() {
  const bad = validateManifest(['nickname', 'vault-keys', 'chat'], [['nickname']])
  const good = validateManifest(['nickname', 'bubble', 'companion'], [['companion', 'persona']])
  const ok = bad.length >= 3 && good.length === 0
  console.log(`自测：违规清单命中 ${bad.length} 条，合规清单命中 ${good.length} 条`)
  if (!ok) {
    for (const item of bad) console.log(`  应命中：${item}`)
    console.log('SYNC_MANIFEST_SELFTEST_FAILED')
    process.exit(1)
  }
  console.log('SYNC_MANIFEST_SELFTEST_OK')
  process.exit(0)
}

if (process.argv.includes('--self-test')) {
  selfTest()
}

const source = readFileSync(SYNC_FILE, 'utf8')
const keysBlock = arrayBlock(source, 'SYNCABLE_SETTINGS_KEYS')
const redactedBlock = arrayBlock(source, 'REDACTED_SETTINGS_PATHS')

if (keysBlock === null || redactedBlock === null) {
  console.log('SYNC_MANIFEST_FAILED：在 sync.mjs 中找不到同步清单字面量')
  process.exit(1)
}

const keys = stringList(keysBlock)
const redactedPaths = nestedPaths(redactedBlock)
const violations = validateManifest(keys, redactedPaths)

console.log(`=== 同步包清单 ===`)
console.log(`可同步设置 ${keys.length} 项：${keys.join('、')}`)
console.log(`剔除路径 ${redactedPaths.length} 条：${redactedPaths.map((item) => item.join('.')).join('、') || '(无)'}`)
console.log(`违规 ${violations.length} 条`)

if (violations.length > 0) {
  for (const item of violations) console.log(`  - ${item}`)
  console.log('SYNC_MANIFEST_FAILED')
  process.exit(1)
}

console.log('SYNC_MANIFEST_OK')
