/**
 * 把 bundle 里的 dsh 入口同步到 dsh 项目。
 *
 * dsh 的 renderer 从自己项目内部加载模块，跨项目相对路径在打包后不成立，
 * 所以必须留一份副本。副本不手改，由这个脚本覆盖写入。
 *
 * 目标目录不存在时直接失败：那说明 dsh 项目的模块目录被挪了，
 * 静默跳过会让门禁看着绿、实际装的是旧代码。
 */

import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sourceDir = join(root, 'bundle', 'dyad-petal')
const targetDir = resolve(
  root,
  '..',
  'dsh-pet-framework',
  'apps',
  'desktop',
  'electron',
  'renderer',
  'petals',
  'dyad-pet'
)

const files = ['core.mjs', 'index.mjs']

if (!existsSync(targetDir)) {
  mkdirSync(targetDir, { recursive: true })
}

for (const name of files) {
  const from = join(sourceDir, name)
  if (!existsSync(from)) {
    console.error(`FAIL 源文件不存在：${from}`)
    process.exit(1)
  }
  copyFileSync(from, join(targetDir, name))
  console.log(`PETAL_SYNCED ${name}`)
}

console.log(`PETAL_SYNC_OK ${targetDir}`)
