// 打包入口：正式包与调试包分目录，sourcemap 永不进正式包。
//
// 用法：
//   node scripts/package.mjs --edition=qiqi    # 私人版 -> dist-pkg-qiqi（放开，仅本机）
//   node scripts/package.mjs --edition=public  # 公开版 -> dist-pkg（合规，可对外）
//   node scripts/package.mjs --include-debug   # 调试包 -> dist-pkg-debug（构建时带 sourcemap）
//
// 不传 --edition 时按公开版处理：宁可收住，也不误发。
//
// 正式包与调试包各自先构建再打包；调试包的 map 只落在 dist-pkg-debug，
// check-package 会断言正式包内 *.map 为 0。

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const debug = process.argv.includes('--include-debug')
const editionArg = process.argv.find((arg) => arg.startsWith('--edition='))
const edition = (editionArg ? editionArg.slice('--edition='.length) : 'public').trim().toLowerCase()
if (edition !== 'qiqi' && edition !== 'public') {
  console.error(`FAIL 未知版本 "${edition}"：只接受 --edition=qiqi 或 --edition=public`)
  process.exit(1)
}
const outName = debug ? 'dist-pkg-debug' : edition === 'qiqi' ? 'dist-pkg-qiqi' : 'dist-pkg'
const outDir = path.join(root, outName)
const editionFile = path.join(root, 'apps', 'desktop', 'electron', 'edition.txt')
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'

function run(args) {
  const result = spawnSync(pnpm, args, { cwd: root, stdio: 'inherit', shell: true })
  if (result.status !== 0) {
    console.error(`FAIL ${pnpm} ${args.join(' ')} (exit ${result.status ?? result.error})`)
    process.exit(result.status ?? 1)
  }
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    out.push({ full, dir: entry.isDirectory() })
    if (entry.isDirectory()) walk(full, out)
  }
  return out
}

console.log(`=== 版本：${edition === 'qiqi' ? '私人版（放开）' : '公开版（合规）'} ===`)
// 构建前写进源码目录，随 apps/desktop/electron/*.txt 进包；结束后恢复原值。
const previousEdition = fs.existsSync(editionFile) ? fs.readFileSync(editionFile, 'utf8') : null
fs.writeFileSync(editionFile, `${edition}\n`, 'utf8')

console.log(`=== 构建（${debug ? '调试包 / sourcemap 开' : '正式包'}）===`)
run(['-r', 'run', 'build'])
if (debug) {
  // 各包 build 脚本固定 tsc -p tsconfig.build.json（sourceMap:false）。
  // 调试通道在 build 之后用 tsc 重新编译一遍，显式打开 sourcemap。
  console.log('=== 重编译（sourcemap）===')
  run(['-r', 'exec', 'tsc', '-p', 'tsconfig.build.json', '--sourceMap'])
}

console.log(`=== electron-builder --dir -> ${outName} ===`)
let debugConfigPath = null
try {
  if (debug) {
    // 正式配置用 '!**/*.map' 挡掉依赖自带与残留的 map；
    // 调试通道生成一份临时配置，去掉这条排除并改输出目录。
    const base = fs.readFileSync(path.join(root, 'electron-builder.yml'), 'utf8')
    const text = base
      .replace(/output:\s*dist-pkg/, 'output: dist-pkg-debug')
      .split(/\r?\n/)
      .filter((line) => !line.trim().startsWith("- '!**/*.map'"))
      .join('\n')
    debugConfigPath = path.join(root, 'electron-builder.debug.yml')
    fs.writeFileSync(debugConfigPath, text, 'utf8')
    run(['exec', 'electron-builder', '--dir', '--win', '--config', 'electron-builder.debug.yml'])
  } else {
    run(['exec', 'electron-builder', '--dir', '--win', `--config.directories.output=${outName}`])
  }
} finally {
  if (debugConfigPath && fs.existsSync(debugConfigPath)) fs.unlinkSync(debugConfigPath)
  // 源码目录保持原状，避免本地开发被上一次打包的版本带走。
  if (previousEdition === null) fs.rmSync(editionFile, { force: true })
  else fs.writeFileSync(editionFile, previousEdition, 'utf8')
}

// 校验和锁 resources/app；文件放 resources/ 下，随包分发但不进 git。
const appDir = path.join(outDir, 'win-unpacked', 'resources', 'app')
const checksumFile = path.join(outDir, 'win-unpacked', 'resources', 'checksums-sha256.txt')
const files = walk(appDir)
  .filter((entry) => !entry.dir)
  .map((entry) => ({ full: entry.full, rel: path.relative(appDir, entry.full).split(path.sep).join('/') }))
  .sort((a, b) => a.rel.localeCompare(b.rel))

const lines = files.map(({ full, rel }) => {
  const hash = createHash('sha256').update(fs.readFileSync(full)).digest('hex')
  return `${hash}  ${rel}`
})
fs.writeFileSync(checksumFile, `${lines.join('\n')}\n`, 'utf8')
console.log(`INFO 校验和 ${lines.length} 个文件 -> ${path.relative(root, checksumFile)}`)

console.log(`=== 核对 ${outName} ===`)
const check = spawnSync(process.execPath, [path.join(root, 'scripts', 'check-package.mjs'), `--root=${outName}`], {
  cwd: root,
  stdio: 'inherit'
})
if (check.status !== 0) process.exit(check.status ?? 1)
