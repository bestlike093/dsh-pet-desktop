#!/usr/bin/env node
/**
 * 素材体积审计与可选压缩。
 *
 * 三种模式：
 *   审计：node scripts/optimize-assets.mjs
 *   预演：node scripts/optimize-assets.mjs --write [--out DIR]
 *   落地：node scripts/optimize-assets.mjs --apply [--all]
 *
 * --apply 默认只处理超过 512KB 的图（--all 才处理全部），且必须同时满足：
 *   1. 能探测到原图与压缩产物的宽高和像素格式；
 *   2. 宽高完全一致，alpha 通道没有丢失；
 *   3. 原图已备份到 assets/.bak/<时间戳>/ 且备份字节数校验通过；
 *   4. 压缩产物确实比原图小。
 * 任一条件不满足就跳过该文件，不做替换。替换用同目录临时文件 rename，
 * 失败时从备份复制回原处。
 */

import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(here, '..')
const assetsRoot = path.join(projectRoot, 'assets')

/** 超过这个体积的单张图会在报告里标出来，也是 --apply 的默认目标。 */
const LARGE_FILE_BYTES = 512 * 1024

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp'])

function parseArgs(argv) {
  const options = {
    write: false,
    apply: false,
    all: false,
    out: path.join(os.tmpdir(), 'cyrene-assets-optimized')
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--write') options.write = true
    else if (arg === '--apply') {
      options.apply = true
      options.write = true
    } else if (arg === '--all') options.all = true
    else if (arg === '--out') {
      const next = argv[index + 1]
      if (typeof next === 'string' && next !== '') {
        options.out = path.resolve(next)
        index += 1
      }
    }
  }
  return options
}

function run(command, args) {
  return new Promise((resolve) => {
    execFile(command, args, { windowsHide: true, timeout: 120_000 }, (error, stdout, stderr) => {
      resolve({ ok: error === null, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
    })
  })
}

/** 探测外部工具；找不到就返回 null，不抛。 */
async function detectTool() {
  const candidates = [
    { name: 'pngquant', probe: ['--version'] },
    { name: 'magick', probe: ['-version'] }
  ]
  for (const candidate of candidates) {
    const result = await run(candidate.name, candidate.probe)
    if (result.ok) return candidate.name
  }
  return null
}

async function walk(dir, out = []) {
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    // 备份目录里的图不参与审计与压缩，否则会反复压自己的备份
    if (entry.isDirectory()) {
      if (entry.name === '.bak') continue
      await walk(path.join(dir, entry.name), out)
      continue
    }
    if (!entry.isFile()) continue
    if (!IMAGE_EXTS.has(path.extname(entry.name).toLowerCase())) continue
    const full = path.join(dir, entry.name)
    const stat = await fs.stat(full).catch(() => null)
    if (stat === null) continue
    out.push({ path: full, relative: path.relative(projectRoot, full), bytes: stat.size })
  }
  return out
}

function human(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

/** 用 ffprobe 读宽高与像素格式；拿不到就返回 null，不猜。 */
async function probe(file) {
  const result = await run('ffprobe', [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=width,height,pix_fmt',
    '-of',
    'csv=p=0',
    file
  ])
  if (!result.ok) return null
  const first = (result.stdout.trim().split(/\r?\n/)[0] ?? '').trim()
  const [width, height, pixFmt] = first.split(',')
  if (width === undefined || height === undefined || pixFmt === undefined) return null
  const size = { width: Number(width), height: Number(height), pixFmt }
  if (!Number.isFinite(size.width) || !Number.isFinite(size.height)) return null
  return size
}

/** 只看常见的带 alpha 像素格式，避免把 gray 里的字母 a 误判成 alpha。 */
function hasAlpha(pixFmt) {
  return /^(rgba|bgra|argb|abgr|ya8|ya16|gbrap|yuva)/i.test(pixFmt)
}

/** 按 pngquant / magick 压一张；返回新文件路径或 null。 */
async function compress(tool, file, outDir, { keepExt = false } = {}) {
  const ext = keepExt ? path.extname(file.path).toLowerCase() : '.png'
  const base = path.basename(file.path, path.extname(file.path))
  const target = path.join(outDir, `${base}${ext}`)
  if (tool === 'pngquant') {
    // pngquant 只吃 PNG、也只出 PNG；非 PNG 原图交给 magick
    if (keepExt && ext !== '.png') return null
    const result = await run('pngquant', [
      '--quality',
      '65-90',
      '--speed',
      '3',
      '--force',
      '--output',
      target,
      file.path
    ])
    return result.ok ? target : null
  }
  const result = await run('magick', [file.path, '-strip', '-quality', '82', target])
  return result.ok ? target : null
}

async function makeBackupRoot() {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '')
  const dir = path.join(assetsRoot, '.bak', stamp)
  await fs.mkdir(dir, { recursive: true })
  return dir
}

/** 压缩一张并落地；返回 {ok, saved?, reason?}。 */
async function applyOne(tool, file, outDir, backupRoot) {
  const before = await probe(file.path)
  if (before === null) return { ok: false, reason: 'ffprobe 读不到原图尺寸' }

  const packed = await compress(tool, file, outDir, { keepExt: true })
  if (packed === null) return { ok: false, reason: '没有可用的压缩工具或压缩失败' }

  const after = await probe(packed)
  if (after === null) return { ok: false, reason: 'ffprobe 读不到压缩产物' }
  if (after.width !== before.width || after.height !== before.height) {
    return { ok: false, reason: `尺寸变化 ${before.width}x${before.height} → ${after.width}x${after.height}` }
  }
  if (hasAlpha(before.pixFmt) && !hasAlpha(after.pixFmt)) {
    return { ok: false, reason: `alpha 丢失 ${before.pixFmt} → ${after.pixFmt}` }
  }

  const packedStat = await fs.stat(packed).catch(() => null)
  if (packedStat === null) return { ok: false, reason: '压缩产物不存在' }
  if (packedStat.size >= file.bytes) return { ok: false, reason: '压缩后没有变小' }

  const relative = path.relative(assetsRoot, file.path)
  const backupPath = path.join(backupRoot, relative)
  await fs.mkdir(path.dirname(backupPath), { recursive: true })
  await fs.copyFile(file.path, backupPath)
  const backupStat = await fs.stat(backupPath).catch(() => null)
  if (backupStat === null || backupStat.size !== file.bytes) {
    return { ok: false, reason: '备份校验失败，未替换' }
  }

  // 临时文件必须和目标同目录（同盘），rename 才是原子操作
  const tempPath = `${file.path}.tmp-optimize`
  await fs.copyFile(packed, tempPath)
  try {
    await fs.rename(tempPath, file.path)
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => {})
    await fs.copyFile(backupPath, file.path).catch(() => {})
    return { ok: false, reason: `替换失败并已回滚：${String(error.message ?? error)}` }
  }
  return { ok: true, saved: file.bytes - packedStat.size, backupPath }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const files = await walk(assetsRoot)
  if (files.length === 0) {
    console.log(`[assets] ${assetsRoot} 下没有可审计的位图`)
    return
  }

  const total = files.reduce((sum, item) => sum + item.bytes, 0)
  const large = files.filter((item) => item.bytes >= LARGE_FILE_BYTES)
  console.log(`[assets] 位图 ${files.length} 张，合计 ${human(total)}`)
  if (large.length > 0) {
    console.log(`[assets] 超过 ${human(LARGE_FILE_BYTES)} 的文件：`)
    for (const item of large.sort((a, b) => b.bytes - a.bytes)) {
      console.log(`  ${human(item.bytes).padStart(9)}  ${item.relative}`)
    }
  } else {
    console.log('[assets] 没有单张超过阈值的文件')
  }

  const tool = await detectTool()

  if (options.apply) {
    if (tool === null) {
      console.log('[assets] 未检测到 pngquant 或 magick，--apply 已跳过，未改动任何文件')
      return
    }
    const targets = options.all ? files : large
    if (targets.length === 0) {
      console.log('[assets] 没有需要压缩的文件，未改动任何文件')
      return
    }
    await fs.mkdir(options.out, { recursive: true })
    const backupRoot = await makeBackupRoot()
    let replaced = 0
    let saved = 0
    let skipped = 0
    for (const file of targets) {
      const result = await applyOne(tool, file, options.out, backupRoot)
      if (!result.ok) {
        skipped += 1
        console.log(`  SKIP ${file.relative}：${result.reason}`)
        continue
      }
      replaced += 1
      saved += result.saved
      console.log(`  OK   ${file.relative}  省下 ${human(result.saved)}`)
    }
    console.log(
      `[assets] 用 ${tool} 替换 ${replaced} 张，跳过 ${skipped} 张，共省下 ${human(saved)}`
    )
    console.log(`[assets] 原图备份在 ${path.relative(projectRoot, backupRoot)}`)
    return
  }

  if (!options.write) {
    console.log('[assets] 只审计；要预演压缩请加 --write，要真正替换请加 --apply')
    return
  }

  if (tool === null) {
    console.log('[assets] 未检测到 pngquant 或 magick，未做任何压缩')
    console.log('[assets] 安装任一工具后重跑即可；原图不会被改动')
    return
  }

  await fs.mkdir(options.out, { recursive: true })
  let saved = 0
  let compressed = 0
  for (const file of files) {
    const result = await compress(tool, file, options.out)
    if (result === null) continue
    const stat = await fs.stat(result).catch(() => null)
    if (stat === null) continue
    compressed += 1
    saved += Math.max(0, file.bytes - stat.size)
  }
  console.log(`[assets] 用 ${tool} 压缩 ${compressed} 张，共省下 ${human(saved)}`)
  console.log(`[assets] 产物在 ${options.out}，确认后再替换 assets/ 里的原图`)
}

await main()
