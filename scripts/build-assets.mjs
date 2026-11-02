#!/usr/bin/env node
/**
 * 从归档源图生成运行时素材。
 *
 * 约定：
 *   assets-gen/source/**  原图归档，唯一真源，git 跟踪，不进安装包
 *   assets/**             生成物，运行时与打包使用
 *
 * 规则（按顺序）：
 *   1. 长边超过 512 的图先等比缩到 512，避免几 MB 的图直接进包
 *   2. pngquant 量化到 256 色，保留 8bit alpha；pngquant 缺失时退到无损
 *   3. 量化后仍超 512KB 的单张升档为无损，再超就保留较小的那份并告警
 *
 * 用法：
 *   node scripts/build-assets.mjs             # 增量生成（源比产物新才处理）
 *   node scripts/build-assets.mjs --force     # 全量重生成
 *   node scripts/build-assets.mjs --import    # 一次性：把 assets 下原图 git mv 到归档
 */

import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const sourceRoot = path.join(root, 'assets-gen', 'source')
const assetsRoot = path.join(root, 'assets')
const tempRoot = path.join(os.tmpdir(), 'cyrene-assets-build')

const LIMIT = 512 * 1024
const MAX_EDGE = 512
const PNG = /\.png$/i
const force = process.argv.includes('--force')
const importMode = process.argv.includes('--import')

const kb = (bytes) => `${(bytes / 1024).toFixed(1)}KB`

async function exists(target) {
  try {
    await fs.access(target)
    return true
  } catch {
    return false
  }
}

async function walk(dir, out = []) {
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) await walk(full, out)
    else if (entry.isFile() && PNG.test(entry.name)) out.push(full)
  }
  return out
}

/** pngquant 缺失时如实返回 null，调用方退到无损。 */
async function detectPngquant() {
  const candidates = [
    process.env.PNGQUANT_BIN,
    path.join(process.env.LOCALAPPDATA ?? '', 'pngquant', 'pngquant', 'pngquant.exe'),
    'pngquant'
  ].filter(Boolean)

  for (const bin of candidates) {
    try {
      const { stdout } = await execFileAsync(bin, ['--version'], { windowsHide: true })
      return { bin, version: String(stdout).trim().split('\n')[0] }
    } catch {
      // 继续试下一个
    }
  }
  return null
}

async function probeSize(file) {
  const { stdout } = await execFileAsync(
    'ffprobe',
    [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=width,height',
      '-of',
      'csv=p=0',
      file
    ],
    { windowsHide: true }
  )
  const [width, height] = String(stdout).trim().split(',').map(Number)
  return { width, height }
}

async function run(command, args) {
  try {
    await execFileAsync(command, args, { windowsHide: true, timeout: 180_000 })
    return true
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    console.error(`  ! ${path.basename(command)} 失败：${detail}`)
    return false
  }
}

/** 缩放到长边 512；小图原样返回源路径。 */
async function scaleIfNeeded(source, width, height) {
  const longEdge = Math.max(width, height)
  if (longEdge <= MAX_EDGE) return { file: source, scaled: false }

  const scaled = path.join(tempRoot, `scaled-${path.basename(source)}`)
  const filter =
    width >= height ? `scale=${MAX_EDGE}:-2:flags=lanczos` : `scale=-2:${MAX_EDGE}:flags=lanczos`
  const ok = await run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', source, '-vf', filter, scaled])
  if (!ok) return { file: source, scaled: false }
  return { file: scaled, scaled: true }
}

async function quantize(input, output, pngquant) {
  if (pngquant === null) {
    return lossless(input, output)
  }
  const ok = await run(pngquant.bin, [
    '--quality=65-85',
    '--speed',
    '3',
    '--strip',
    '--force',
    '--output',
    output,
    input
  ])
  if (ok) return true

  // 小图或颜色太碎时达不到 65 的下限，pngquant 会直接退出；放宽再试一次。
  const relaxed = await run(pngquant.bin, [
    '--quality=0-85',
    '--speed',
    '1',
    '--strip',
    '--force',
    '--output',
    output,
    input
  ])
  if (relaxed) return true
  return lossless(input, output)
}

async function lossless(input, output) {
  return run('ffmpeg', [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    input,
    '-c:v',
    'png',
    '-compression_level',
    '100',
    output
  ])
}

async function buildOne(source, pngquant) {
  const rel = path.relative(sourceRoot, source)
  const output = path.join(assetsRoot, rel)
  const sourceStat = await fs.stat(source)

  if (!force && (await exists(output))) {
    const outputStat = await fs.stat(output)
    if (outputStat.mtimeMs >= sourceStat.mtimeMs) {
      return { rel, status: 'skip', sourceBytes: sourceStat.size, outputBytes: outputStat.size }
    }
  }

  await fs.mkdir(path.dirname(output), { recursive: true })
  await fs.mkdir(tempRoot, { recursive: true })

  let { width, height } = await probeSize(source)
  const staged = await scaleIfNeeded(source, width, height)

  await quantize(staged.file, output, pngquant)
  if (!(await exists(output))) {
    return { rel, status: 'fail', sourceBytes: sourceStat.size, outputBytes: 0 }
  }

  let resultBytes = (await fs.stat(output)).size
  let mode = pngquant === null ? 'lossless' : 'quantized'
  let warning = null

  if (resultBytes > LIMIT) {
    // 升档：先试缩放后的无损，通常比 256 色大、但仍可能低于阈值
    const fullOutput = path.join(tempRoot, `full-${path.basename(source)}`)
    if (await lossless(staged.file, fullOutput)) {
      const fullBytes = (await fs.stat(fullOutput)).size
      if (fullBytes <= LIMIT || fullBytes < resultBytes) {
        await fs.copyFile(fullOutput, output)
        resultBytes = fullBytes
        mode = 'lossless'
      }
    }
    if (resultBytes > LIMIT) {
      warning = `生成后仍超 ${kb(LIMIT)}：${rel} ${kb(resultBytes)}`
    }
  }

  return {
    rel,
    status: warning === null ? 'ok' : 'warn',
    mode,
    scaled: staged.scaled,
    sourceBytes: sourceStat.size,
    outputBytes: resultBytes,
    warning
  }
}

/** 一次性迁移：assets 下 PNG 全部 git mv 到归档，随后由本脚本生成压缩版。 */
async function importToSource() {
  const files = await walk(assetsRoot)
  let moved = 0
  for (const file of files) {
    const rel = path.relative(assetsRoot, file)
    const dest = path.join(sourceRoot, rel)
    await fs.mkdir(path.dirname(dest), { recursive: true })
    try {
      await execFileAsync('git', ['mv', file, dest], { cwd: root, windowsHide: true })
      moved += 1
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      console.error(`  ! git mv 失败：${rel} — ${detail}`)
    }
  }
  console.log(`ASSETS_IMPORTED ${moved} 张 -> ${path.relative(root, sourceRoot)}`)
}

async function main() {
  if (importMode) {
    await importToSource()
    return
  }

  const pngquant = await detectPngquant()
  const files = await walk(sourceRoot)
  if (files.length === 0) {
    console.log(`ASSETS_BUILD_EMPTY 归档目录为空：${path.relative(root, sourceRoot)}`)
    return
  }

  console.log(
    `assets:build 源 ${files.length} 张｜pngquant ${pngquant === null ? '未找到，退到无损' : pngquant.version}`
  )

  const results = []
  for (const file of files) {
    const result = await buildOne(file, pngquant)
    results.push(result)
    if (result.status === 'ok') {
      console.log(
        `  ok   ${result.rel}  ${kb(result.sourceBytes)} -> ${kb(result.outputBytes)}  ${result.mode}${result.scaled ? ' / 512' : ''}`
      )
    } else if (result.status === 'warn') {
      console.log(`  warn ${result.rel}  ${kb(result.sourceBytes)} -> ${kb(result.outputBytes)}  ${result.warning}`)
    } else if (result.status === 'fail') {
      console.log(`  fail ${result.rel}`)
    }
  }

  const changed = results.filter((item) => item.status !== 'skip')
  const totalSource = changed.reduce((sum, item) => sum + item.sourceBytes, 0)
  const totalOutput = changed.reduce((sum, item) => sum + item.outputBytes, 0)
  const warnings = results.filter((item) => item.status === 'warn').length

  console.log(
    `ASSETS_BUILD_DONE 处理 ${changed.length}｜跳过 ${results.length - changed.length}｜告警 ${warnings}｜` +
      `${kb(totalSource)} -> ${kb(totalOutput)}`
  )
}

await main()
