// 素材授权门禁：assets/ 下每个目录都要在 ATTRIBUTION.md 里有来源说明。
// 用法：node scripts/check-assets-license.mjs
// 退出码：0 通过 / 1 失败
//
// 目的：新素材进仓库时顺手进包，是这类项目最容易出的授权事故。
//       这里不判断画得好不好，只要求「有说明、有图、没有模型文件」。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const assetsRoot = path.join(root, 'assets')
const attributionPath = path.join(assetsRoot, 'ATTRIBUTION.md')

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp'])
/** 模型文件一律不进素材目录；发布包只认图片。 */
const MODEL_SUFFIXES = ['.moc3', '.model3.json', '.motion3.json', '.physics3.json']

let failed = 0
function check(ok, label, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failed += 1
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else out.push(full)
  }
  return out
}

const attribution = fs.existsSync(attributionPath)
  ? fs.readFileSync(attributionPath, 'utf8')
  : ''

check(attribution !== '', 'assets/ATTRIBUTION.md 存在')
for (const keyword of ['自制', '授权', '发布', 'Live2D']) {
  check(attribution.includes(keyword), `授权声明包含「${keyword}」`)
}

if (!fs.existsSync(assetsRoot)) {
  check(false, 'assets/ 目录存在')
} else {
  const dirs = fs
    .readdirSync(assetsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort()

  check(dirs.length > 0, '至少有一个素材目录')

  for (const name of dirs) {
    const dir = path.join(assetsRoot, name)
    const files = walk(dir)
    const images = files.filter((file) => IMAGE_EXTS.has(path.extname(file).toLowerCase()))
    const models = files.filter((file) => {
      const lower = file.toLowerCase()
      return MODEL_SUFFIXES.some((suffix) => lower.endsWith(suffix))
    })

    check(images.length > 0, `${name} 含可用图片`, `${images.length} 张`)
    check(attribution.includes(name), `${name} 已在 ATTRIBUTION.md 说明`)
    check(
      models.length === 0,
      `${name} 不含模型文件`,
      models[0] ? path.relative(assetsRoot, models[0]) : ''
    )
  }

  const placeholders = walk(assetsRoot).filter((file) =>
    path.basename(file).startsWith('PLACEHOLDER')
  )
  check(placeholders.length === 0, 'assets/ 下无 PLACEHOLDER* 文件')

  // 编辑源与试稿只留在 assets-source/。它们会跟着 assets/** 进发布包，
  // 但渲染代码从不读取，属于打包清洁度问题，必须挡在门禁上。
  const nonRuntime = walk(assetsRoot).filter((file) => {
    const parts = path.relative(assetsRoot, file).toLowerCase().split(path.sep)
    const base = parts[parts.length - 1]
    const inScratchDir = parts.slice(0, -1).some((seg) => seg === 'samples' || seg === 'ref')
    const scratchFile =
      base === 'preview.html' || base.startsWith('broken-404') || base.startsWith('sheet-whale-2f')
    return inScratchDir || scratchFile
  })
  check(
    nonRuntime.length === 0,
    'assets/ 只含运行时素材',
    nonRuntime
      .slice(0, 3)
      .map((file) => path.relative(assetsRoot, file))
      .join(', ')
  )
}

if (failed > 0) {
  console.log(`ASSETS_LICENSE_FAIL ${failed} 项`)
  process.exit(1)
}
console.log('ASSETS_LICENSE_OK')
