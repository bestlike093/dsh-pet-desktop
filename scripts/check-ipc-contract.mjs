#!/usr/bin/env node
/**
 * IPC 契约门禁：白名单、主进程注册、preload 暴露三处必须对得上。
 *
 * 只比对文本，不启动 Electron。任何一处漏登记都会让「能调但没人知道」
 * 或「登记了没人处理」的通道混过去，这个脚本负责把它们拦在 verify 阶段。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ipcFile = path.join(root, 'apps/desktop/src/ipc.ts')
const mainFile = path.join(root, 'apps/desktop/electron/main.mjs')
const ipcModulesDir = path.join(root, 'apps/desktop/src/main/ipc')
const preloadFile = path.join(root, 'apps/desktop/electron/preload.cjs')

function read(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch (error) {
    console.error(`[ipc-contract] 读不到文件：${file}`)
    console.error(String(error))
    process.exit(1)
  }
}

/** 契约扫描要覆盖 ipc 子目录，迁移到 ipc/queries/ 后仍能看见注册点。 */
function listTsFiles(dir) {
  if (!fs.existsSync(dir)) return []
  const files = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) files.push(...listTsFiles(full))
    else if (entry.name.endsWith('.ts')) files.push(full)
  }
  return files
}

function unique(values) {
  return [...new Set(values)]
}

function collectAll(source, pattern) {
  const out = []
  for (const match of source.matchAll(pattern)) out.push(match[1])
  return out
}

function collect(source, pattern) {
  return unique(collectAll(source, pattern))
}

/**
 * 注册面与 preload 暴露面的判定口径：
 * - 注册面 ⊆ 暴露面：正常；
 * - 注册面里多出来的通道，只有登记进 INTERNAL_CHANNELS 的内部通道才允许，其余一律报错；
 * - 暴露面里多出来的通道同样报错，避免 preload 调一个没人处理的通道；
 * - 不把「暂时没接线」塞进白名单，白名单只收真正只由主进程触发的内部通道。
 *
 * 白名单规则（只增不改）：
 * - 每个条目必须带注释，写明「为什么只内部触发」，例如主进程定时器触发、窗口生命周期回调；
 * - 要让渲染侧可调，必须同时动 preload 暴露面与 packages/shared/contracts.snapshot.json，
 *   不能只从白名单里删掉就算完；
 * - 禁止因为「本轮还没接线」新增条目，那会把假红养成习惯。
 *
 * 当前基线 71 条，其中 1 条内部通道（备份锁探针）没有渲染入口。mutations 搬迁时按这个口径判，
 * 不降级成 warning，否则假红会被习惯性忽略。
 */
const INTERNAL_CHANNELS = new Set([
  // 备份锁探针：只给主进程诊断与测试读锁状态，没有任何渲染入口。
  // 要暴露给渲染，必须同时改 preload 与契约快照，不能只从白名单里删。
  'pet:backup:probe'
])

const ipcSource = read(ipcFile)
const block = /export const IPC_CHANNELS = \[([\s\S]*?)\] as const/.exec(ipcSource)
if (block === null) {
  console.error('[ipc-contract] 在 ipc.ts 里找不到 IPC_CHANNELS 数组')
  process.exit(1)
}

const listed = collect(block[1], /'([^']+)'/g)
const ipcSources = listTsFiles(ipcModulesDir).map((file) => ({
  file,
  source: fs.readFileSync(file, 'utf8')
}))

const reverseImports = ipcSources
  .filter(({ source }) =>
    /(?:from\s+|require\()\s*['"][^'"]*electron\/main\.mjs['"]|import\s*\(\s*['"][^'"]*electron\/main\.mjs['"]\s*\)/.test(
      source
    )
  )
  .map(({ file }) => path.relative(root, file))

/**
 * 注册点的三种写法都要认：
 * - registerChannel('pet:...')
 * - deps.registerChannel('pet:...')
 * - const register = deps.registerChannel; register('pet:...')
 * 只扫描行首 register( 会漏掉依赖注入形态，这里统一放宽。
 */
const REGISTRATION_PATTERN =
  /(?:^|\n)\s*(?:[\w$]+\s*\.\s*)?register(?:Channel)?\s*\(\s*['"](pet:[^'"]+)['"]/g

function collectRegistrations(source) {
  return collectAll(source, REGISTRATION_PATTERN)
}

// 反例自测：这个夹具故意只走 deps 注册，必须被扫到。
// 没有这条，正则被「优化」回行首 register( 时不会有人发现。
const fixtureFile = path.join(root, 'scripts/fixtures/ipc-contract/deps-only.ts')
if (!collectRegistrations(read(fixtureFile)).includes('pet:fixture:deps-only')) {
  console.error('[ipc-contract] 自测失败：deps 注入形态的注册未被扫描到')
  process.exit(1)
}

const registeredRaw = [
  ...collectRegistrations(read(mainFile)),
  ...ipcSources.flatMap(({ source }) => collectRegistrations(source))
]
const registered = unique(registeredRaw)
const registeredDuplicates = registeredRaw.filter(
  (channel, index) => registeredRaw.indexOf(channel) !== index
)
const preloadSource = read(preloadFile)
const exposed = unique([
  ...collect(preloadSource, /ipcRenderer\.invoke\(\s*'([^']+)'/g),
  ...collect(preloadSource, /ipcRenderer\.send\(\s*'([^']+)'/g)
])

const missingInList = registered.filter((channel) => !listed.includes(channel))
const missingInMain = listed.filter((channel) => !registered.includes(channel))
const exposedNotListed = exposed.filter((channel) => !listed.includes(channel))
const notExposed = listed.filter((channel) => !exposed.includes(channel))

// voice 域按通道逐个守：每个 voice 通道必须恰好注册一次。
// 不绑文件行号，迁移后自动继续生效。
const voiceChannels = listed.filter((channel) => channel.startsWith('pet:voice:'))
const voiceCounts = new Map()
for (const channel of registeredRaw) {
  if (channel.startsWith('pet:voice:')) {
    voiceCounts.set(channel, (voiceCounts.get(channel) ?? 0) + 1)
  }
}
const voiceMisregistered = voiceChannels.filter((channel) => voiceCounts.get(channel) !== 1)

const problems = []
if (voiceMisregistered.length > 0) {
  problems.push(`voice 通道注册次数不为 1：${voiceMisregistered.join(', ')}`)
}
if (reverseImports.length > 0) {
  problems.push(`ipc 模块反向 import 主进程入口：${reverseImports.join(', ')}`)
}
if (registeredDuplicates.length > 0) {
  problems.push(`通道重复注册：${unique(registeredDuplicates).join(', ')}`)
}
if (missingInList.length > 0) {
  problems.push(`主进程注册了但白名单没有：${missingInList.join(', ')}`)
}
if (exposedNotListed.length > 0) {
  problems.push(`preload 暴露了但白名单没有：${exposedNotListed.join(', ')}`)
}
if (missingInMain.length > 0) {
  problems.push(`白名单有但主进程没注册：${missingInMain.join(', ')}`)
}

console.log(`[ipc-contract] 白名单 ${listed.length}，注册 ${registered.length}，preload ${exposed.length}`)

if (notExposed.length > 0) {
  const unexpected = notExposed.filter((channel) => !INTERNAL_CHANNELS.has(channel))
  if (unexpected.length > 0) {
    problems.push(`已注册但既未暴露也不在内部通道白名单：${unexpected.join(', ')}`)
  }
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`[ipc-contract] ${problem}`)
  process.exit(1)
}

console.log('[ipc-contract] PASS')
