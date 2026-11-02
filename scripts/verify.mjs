// P6 门禁：依赖方向、dist 体积、p0-p6 全量冒烟
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkDependencies, formatBytes, walkSize } from './lib/gate.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGES = ['packages/shared', 'packages/core', 'packages/ui', 'packages/vault', 'packages/memory', 'apps/desktop']
const SMOKES = ['p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'memory', 'contracts', 'contract-guard', 'minimal']
const TOTAL_LIMIT = 2 * 1024 * 1024
const SINGLE_LIMIT = 256 * 1024

let failed = 0
function line(ok, text) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${text}`)
  if (!ok) failed += 1
}

console.log('=== 依赖方向 ===')
const manifests = {}
for (const path of PACKAGES) {
  manifests[path] = JSON.parse(readFileSync(join(root, path, 'package.json'), 'utf8'))
}
const deps = checkDependencies(manifests)
line(deps.ok, deps.ok ? '依赖方向与零运行时依赖符合契约' : `依赖违规：${deps.violations.join('；')}`)

console.log('\n=== 浏览器入口 ===')
const browserGate = spawnSync(process.execPath, [join(root, 'scripts', 'check-browser-entry.mjs')], {
  encoding: 'utf8'
})
const browserOutput = `${browserGate.stdout ?? ''}${browserGate.stderr ?? ''}`
const browserPass = (browserOutput.match(/^PASS /gm) ?? []).length
const browserFail = (browserOutput.match(/^FAIL /gm) ?? []).length
line(browserGate.status === 0 && browserFail === 0 && browserPass > 0, `browser 入口 ${browserPass} 项通过${browserFail > 0 ? `，${browserFail} 项失败` : ''}`)
if (browserGate.status !== 0) console.log(browserOutput)

console.log('\n=== dist 体积 ===')
let totalBytes = 0
for (const path of PACKAGES) {
  const size = walkSize(join(root, path, 'dist'))
  totalBytes += size.bytes
  const within = size.bytes <= TOTAL_LIMIT && size.largest.bytes <= SINGLE_LIMIT
  line(
    within,
    `${path}/dist ${formatBytes(size.bytes)} / ${size.files} 文件` +
      (size.largest.path === '' ? '' : `，最大 ${formatBytes(size.largest.bytes)}`)
  )
}
line(totalBytes <= TOTAL_LIMIT, `合计 ${formatBytes(totalBytes)} ≤ ${formatBytes(TOTAL_LIMIT)}`)

console.log('\n=== 密钥明文扫描 ===')
const keyScan = spawnSync(process.execPath, [join(root, 'scripts', 'llm-key-scan.mjs')], {
  encoding: 'utf8'
})
const keyOutput = `${keyScan.stdout ?? ''}${keyScan.stderr ?? ''}`
const keyOk = keyScan.status === 0 && (keyOutput.match(/^FAIL /gm) ?? []).length === 0
line(keyOk, '配置文件明文 key 字段 0 命中')
if (!keyOk) console.log(keyOutput)

console.log('\n=== 脱敏扫描 ===')
const sanitize = spawnSync(process.execPath, [join(root, 'scripts', 'sanitize-check.mjs')], {
  encoding: 'utf8'
})
const sanitizeOutput = `${sanitize.stdout ?? ''}${sanitize.stderr ?? ''}`
const sanitizeOk = sanitize.status === 0
line(sanitizeOk, sanitizeOk ? '工作树域：无本地路径 / 用户名 / 凭据泄漏（域 B 历史另行判定，见 A-25 基线）' : `脱敏扫描失败（exit ${sanitize.status}）`)
if (!sanitizeOk) console.log(sanitizeOutput)

console.log('\n=== 素材体积 ===')
const imageGate = spawnSync(
  process.execPath,
  [join(root, 'scripts', 'check-image-size.mjs'), '--strict'],
  { encoding: 'utf8' }
)
const imageOutput = `${imageGate.stdout ?? ''}${imageGate.stderr ?? ''}`
line(imageGate.status === 0, '素材包图片 ≤512KB/张')
if (imageGate.status !== 0) console.log(imageOutput)

console.log('\n=== 同步清单 ===')
const syncGate = spawnSync(process.execPath, [join(root, 'scripts', 'check-sync-manifest.mjs')], {
  encoding: 'utf8'
})
const syncOutput = `${syncGate.stdout ?? ''}${syncGate.stderr ?? ''}`
line(syncGate.status === 0, '同步包白名单不含密钥、聊天历史与任务日志')
if (syncGate.status !== 0) console.log(syncOutput)

console.log('\n=== 冒烟 ===')
for (const name of SMOKES) {
  const script = join(root, 'scripts', `${name}-smoke.mjs`)
  const result = spawnSync(process.execPath, [script], { encoding: 'utf8' })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  const pass = (output.match(/^PASS /gm) ?? []).length
  const fail = (output.match(/^FAIL /gm) ?? []).length
  const ok = result.status === 0 && fail === 0 && pass > 0
  line(ok, `${name}: ${pass} 项通过${fail > 0 ? `，${fail} 项失败` : ''}`)
  if (!ok) {
    console.log(output.split('\n').filter((item) => item.startsWith('FAIL ')).join('\n'))
    if (result.error !== undefined) console.log(String(result.error))
  }
}

console.log('')
if (failed === 0) {
  console.log('P6_GATE_OK')
  process.exit(0)
}
console.log(`P6_GATE_FAILED_${failed}`)
process.exit(1)
