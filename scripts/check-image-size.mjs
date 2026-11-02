// 素材体积门禁（阶段 0 基线版）。
//
// 只量文件大小，不解码图片：读像素需要额外依赖，而本条要防的是
// 「几 MB 的图被打进安装包」，文件大小已经足够判。
//
// 阈值 512KB，来自清单第 31 条。默认基线模式，只报数字；收紧后加 --strict。

import { readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const ASSETS = join(root, 'assets')
const LIMIT = 512 * 1024
const strict = process.argv.includes('--strict')

const IMAGE = /\.(png|jpe?g|webp|gif|avif|bmp)$/i
const images = []

function walk(dir) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const absolute = join(dir, entry.name)
    // 备份目录不进体积统计：那里存的是原图副本，算进去会让阈值虚高
    if (entry.isDirectory()) {
      if (entry.name === '.bak') continue
      walk(absolute)
      continue
    }
    if (!entry.isFile()) continue
    if (!IMAGE.test(entry.name)) continue
    const { size } = statSync(absolute)
    images.push({
      rel: relative(root, absolute).split('\\').join('/'),
      size
    })
  }
}

walk(ASSETS)
images.sort((a, b) => b.size - a.size)

const oversize = images.filter((item) => item.size > LIMIT)
const totalBytes = images.reduce((sum, item) => sum + item.size, 0)

const kb = (bytes) => `${(bytes / 1024).toFixed(1)}KB`

console.log('=== 图片体积基线 ===')
console.log(`图片 ${images.length} 张，合计 ${kb(totalBytes)}，阈值 ${kb(LIMIT)}`)
console.log(`超过阈值 ${oversize.length} 张`)

if (oversize.length > 0) {
  console.log('超限清单：')
  for (const item of oversize) console.log(`  - ${item.rel} ${kb(item.size)}`)
}

console.log('\n最大的 10 张：')
for (const item of images.slice(0, 10)) {
  console.log(`  - ${item.rel} ${kb(item.size)}`)
}

console.log(`\nIMAGE_SIZE_BASELINE 超限=${oversize.length} 总数=${images.length} 合计=${kb(totalBytes)}`)

if (strict && oversize.length > 0) {
  console.log('IMAGE_SIZE_FAILED')
  process.exit(1)
}

console.log(strict ? 'IMAGE_SIZE_OK' : 'IMAGE_SIZE_OK（基线模式，未判定失败）')
