// 打包产物核对脚本
// 用法：node scripts/check-package.mjs [--root=dist-pkg|dist-pkg-debug]
// 退出码：0 全部通过 / 1 有失败项
//
// ⚠️ PLACEHOLDER 判定用大小写敏感前缀，不用子串匹配
//    （placeholderCard.js 这类正常源码名会被子串匹配误判）

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const rootArg = process.argv.find((arg) => arg.startsWith('--root='))
const outName = rootArg ? rootArg.slice('--root='.length) : 'dist-pkg'
const debug = outName.includes('debug')
const unpacked = path.join(root, outName, 'win-unpacked')
const appRoot = path.join(unpacked, 'resources', 'app')

let failed = 0
function check(ok, label, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failed += 1
}

if (!fs.existsSync(appRoot)) {
  console.log('FAIL 产物不存在，先跑 electron-builder --dir --win')
  process.exit(1)
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    out.push({ name: e.name, full, dir: e.isDirectory() })
    if (e.isDirectory()) walk(full, out)
  }
  return out
}

const entries = walk(appRoot)

// ① 占位文件 / 生成素材目录零命中（大小写敏感前缀；任何开关下都不进包）
const placeholders = entries.filter((e) => e.name.startsWith('PLACEHOLDER'))
const assetsGen = entries.filter((e) => e.name === 'assets-gen')
const firstHit = [...placeholders, ...assetsGen][0]

check(
  placeholders.length === 0,
  '① 无 PLACEHOLDER* 前缀文件',
  placeholders.length ? `${placeholders.length} 个，首个 ${path.relative(appRoot, firstHit.full)}` : ''
)
check(
  assetsGen.length === 0,
  '① 无 assets-gen 目录',
  assetsGen.length ? `${assetsGen.length} 个` : ''
)

// ② apps/desktop 结构
for (const rel of ['apps/desktop/dist', 'apps/desktop/electron', 'apps/desktop/electron/renderer']) {
  check(fs.existsSync(path.join(appRoot, rel)), `② ${rel}`)
}

// ③ 素材必须随包（步 2 定义：assets/ 进包）
// 只认精确目录 assets/，禁 assets* 通配；assets-gen/ 与 PLACEHOLDER* 已由 ① 拦住。
const assetsDir = path.join(appRoot, 'assets')
if (fs.existsSync(assetsDir)) {
  const assetFiles = walk(assetsDir).filter((e) => e.dir === false)
  check(assetFiles.length > 0, '③ 运行时素材 assets/ 已随包', `${assetFiles.length} 个文件`)
  check(
    fs.existsSync(path.join(assetsDir, 'cyrene', 'manifest.json')),
    '③ Cyrene 默认素材已随包',
    'assets/cyrene/manifest.json'
  )
} else {
  check(false, '③ 运行时素材 assets/ 已随包', '目录缺失')
}

// ③b 版权边界：Live2D 模型与旧自制素材都不得出现在发布包里。
// 模型只能由用户导入到 %APPDATA%/desktop-pet/models，绝不随安装包分发。
const relOf = (entry) => path.relative(appRoot, entry.full).split(path.sep).join('/')
const live2dFiles = entries.filter(
  (e) => !e.dir && /[.](moc3|model3[.]json|physics3[.]json|motion3[.]json)$/i.test(e.name)
)
check(
  live2dFiles.length === 0,
  '③ 无 Live2D 模型文件随包',
  live2dFiles.length ? `${live2dFiles.length} 个，首个 ${relOf(live2dFiles[0])}` : ''
)
const legacyAssets = entries.filter((e) => !e.dir && /^assets[/]whale-girl-/.test(relOf(e)))
check(
  legacyAssets.length === 0,
  '③ 无旧 whale-girl 素材随包',
  legacyAssets.length ? `${legacyAssets.length} 个，首个 ${relOf(legacyAssets[0])}` : ''
)

// ④ @pet 在包内且已解引用（真实目录，非 Junction）
const petRoot = path.join(appRoot, 'apps', 'desktop', 'node_modules', '@pet')
const required = ['core', 'shared', 'vault']
if (fs.existsSync(petRoot)) {
  for (const name of required) {
    const pkgDir = path.join(petRoot, name)
    const stat = fs.existsSync(pkgDir) ? fs.lstatSync(pkgDir) : null
    const isLink = stat ? stat.isSymbolicLink() : false
    check(
      Boolean(stat) && !isLink && fs.existsSync(path.join(pkgDir, 'dist')),
      `④ @pet/${name} 已解引用且含 dist`,
      stat ? (isLink ? '仍是链接' : '') : '缺失'
    )
    check(
      fs.existsSync(path.join(pkgDir, 'package.json')),
      `④ @pet/${name} 含 package.json（type:module 依赖它）`
    )
  }
} else {
  check(false, '④ @pet 目录缺失', 'afterPack 钩子未生效')
}

// ④b @pet 位置断言：单来源双落点，单硬落点（删减冒烟见 docs/verify.md）
//   sinkB = node_modules/@pet              ← packages/*/dist/**/*.js   HARD：断了直接 MODULE_NOT_FOUND
//   sinkA = apps/desktop/node_modules/@pet ← apps/desktop/dist/*.js    SOFT：被 sinkB 兜住
const PET_SINKS = [
  { rel: 'node_modules/@pet', tier: 'HARD' },
  { rel: 'apps/desktop/node_modules/@pet', tier: 'SOFT' }
]
const petDirs = entries
  .filter((e) => e.dir && path.basename(e.full) === '@pet')
  .map((e) => path.relative(appRoot, e.full).split(path.sep).join('/'))
  .sort()
check(
  petDirs.length === PET_SINKS.length && PET_SINKS.every((sink) => petDirs.includes(sink.rel)),
  '④ @pet 恰好 2 处：sinkB HARD / sinkA SOFT',
  `${petDirs.length} 处：${petDirs.join(', ')}`
)

// ④c 两个 sink 各做一次真实解析冒烟，证明位置断言不是只数目录
for (const [probeRel, pkg, expectSink, tier] of [
  ['apps/desktop/dist/__resolve__.cjs', '@pet/core', 'apps/desktop/node_modules/@pet', 'SOFT'],
  ['packages/core/dist/assets/__resolve__.cjs', '@pet/shared', 'node_modules/@pet', 'HARD']
]) {
  try {
    const resolved = createRequire(path.join(appRoot, probeRel))
      .resolve(pkg)
      .split(path.sep)
      .join('/')
    check(
      resolved.includes(expectSink),
      `④ [${tier}] ${pkg} 从 ${path.dirname(probeRel)} 解析到 ${expectSink}`,
      path.relative(appRoot, resolved)
    )
  } catch (error) {
    check(false, `④ ${pkg} 从 ${path.dirname(probeRel)} 可解析`, error.code ?? error.message)
  }
}

// ⑤ 体量（仅记录，不设阈值）
let files = 0
let bytes = 0
for (const e of walk(unpacked)) {
  if (e.dir) continue
  files += 1
  bytes += fs.statSync(e.full).size
}
console.log(`INFO ⑤ 产物体量 files=${files} MB=${(bytes / 1024 / 1024).toFixed(1)}`)

// ⑥ 校验和：范围 resources/app，逐行重算必须与落地文件一致
const checksumFile = path.join(unpacked, 'resources', 'checksums-sha256.txt')
if (fs.existsSync(checksumFile)) {
  const actual = fs.readFileSync(checksumFile, 'utf8').trim().split('\n').filter(Boolean)
  const expected = walk(appRoot)
    .filter((e) => !e.dir)
    .map((e) => ({ full: e.full, rel: path.relative(appRoot, e.full).split(path.sep).join('/') }))
    .sort((a, b) => a.rel.localeCompare(b.rel))
    .map(({ full, rel }) => `${createHash('sha256').update(fs.readFileSync(full)).digest('hex')}  ${rel}`)
  check(actual.length === expected.length, '⑥ 校验和行数', `${actual.length} / ${expected.length}`)
  const mismatch = expected.find((line, index) => actual[index] !== line)
  check(!mismatch, '⑥ 校验和可复现', mismatch ? mismatch.slice(0, 90) : '')
} else {
  check(false, '⑥ 校验和文件存在', 'resources/checksums-sha256.txt 缺失')
}

// ⑦ 声明层剔除：工具链包不随包（resolver 结构另开轮）
for (const name of ['lodash', 'gh-pages', 'qs', 'fs-extra', 'async']) {
  check(!fs.existsSync(path.join(appRoot, 'node_modules', name)), `⑦ node_modules/${name} 已剔除`)
}

// ⑧ sourcemap 只允许出现在调试包
const maps = entries.filter((e) => !e.dir && e.name.endsWith('.map'))
check(debug || maps.length === 0, '⑧ 正式包无 *.map', `${maps.length} 个`)
if (debug) console.log(`INFO sourcemap ${maps.length} 个（调试包通道）`)

// 签名：dir 目标不做代码签名
console.log('INFO 签名：不适用（dir 目标，未启用代码签名）')

console.log(failed === 0 ? '\nPACKAGE_CHECK_OK' : `\nPACKAGE_CHECK_FAILED_${failed}`)
process.exit(failed === 0 ? 0 : 1)
