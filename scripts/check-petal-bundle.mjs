/**
 * 双宿主骨架验证。
 *
 * 只验证「同一目录、两个入口、共享内核」在 Node 层面成立：
 *   1. 两份清单的 id / version / entry 互相自洽
 *   2. Cyrene 入口导出 register / unregister
 *   3. dsh 入口导出 meta / bootstrap / teardown，且只用 ESM
 *   4. core.mjs 与生成的 core.cjs 行为一致
 *   5. dsh 侧副本与 bundle 同步
 *
 * 不启动宿主、不写盘、不联网。宿主侧的装机通道是否存在，这个脚本判断不了。
 */

import { createRequire } from 'node:module'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve, extname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const bundleDir = join(root, 'bundle', 'dyad-petal')

const failures = []
const fail = (message) => failures.push(message)
const ok = (message) => console.log(`PASS ${message}`)

function readJson(name) {
  const file = join(bundleDir, name)
  if (!existsSync(file)) {
    fail(`${name} 不存在`)
    return null
  }
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    fail(`${name} 不是合法 JSON：${error.message}`)
    return null
  }
}

// ---- 1. 清单 ----
const manifest = readJson('manifest.json')
const petal = readJson('petal.json')

if (manifest && petal) {
  if (manifest.id !== petal.id) fail(`id 不一致：manifest=${manifest.id} petal=${petal.id}`)
  else ok(`id 一致：${manifest.id}`)

  if (manifest.version !== petal.version) {
    fail(`version 不一致：manifest=${manifest.version} petal=${petal.version}`)
  } else ok(`version 一致：${manifest.version}`)

  const entries = [
    ['manifest.entry', manifest.entry, ['.js', '.cjs']],
    ['petal.entry', petal.entry, ['.js', '.mjs']]
  ]

  for (const [label, entry, allowed] of entries) {
    if (typeof entry !== 'string' || entry.length === 0) {
      fail(`${label} 缺失`)
      continue
    }
    if (entry.includes('..')) {
      fail(`${label} 越界：${entry}`)
      continue
    }
    if (!allowed.includes(extname(entry))) {
      fail(`${label} 扩展名不在 ${allowed.join('/')} 内：${entry}`)
      continue
    }
    if (!existsSync(join(bundleDir, entry))) {
      fail(`${label} 指向的文件不存在：${entry}`)
      continue
    }
    ok(`${label} 可用：${entry}`)
  }

  if (manifest.entry === petal.entry) fail('两个入口指向同一文件，无法验证双形态')
  else ok('两个入口分离')
}

// ---- 2. Cyrene 入口 ----
const require = createRequire(import.meta.url)
const cjsEntry = join(bundleDir, manifest?.entry ?? 'index.cjs')
let cyrenePlugin = null

if (existsSync(cjsEntry)) {
  try {
    cyrenePlugin = require(cjsEntry)
    const shapeOk =
      cyrenePlugin &&
      typeof cyrenePlugin.register === 'function' &&
      typeof cyrenePlugin.unregister === 'function'
    if (shapeOk) ok('Cyrene 入口导出 register / unregister')
    else fail('Cyrene 入口缺少 register 或 unregister')
  } catch (error) {
    fail(`Cyrene 入口加载失败：${error.message}`)
  }
}

// ---- 3. dsh 入口 ----
const mjsEntry = join(bundleDir, petal?.entry ?? 'index.mjs')
let dshModule = null

if (existsSync(mjsEntry)) {
  try {
    dshModule = await import(pathToFileURL(mjsEntry).href)
    const named =
      dshModule.meta && typeof dshModule.bootstrap === 'function' && typeof dshModule.teardown === 'function'
    const fallback =
      dshModule.default &&
      dshModule.default.meta &&
      typeof dshModule.default.bootstrap === 'function' &&
      typeof dshModule.default.teardown === 'function'

    if (!named) fail('dsh 入口缺少具名 meta / bootstrap / teardown')
    else ok('dsh 入口导出 meta / bootstrap / teardown')

    if (!fallback) fail('dsh 入口 default 导出不完整')
    else ok('dsh 入口 default 导出完整')

    if (named && fallback && dshModule.default.meta !== dshModule.meta) {
      fail('default 与具名导出的 meta 不是同一个对象')
    } else if (named && fallback) {
      ok('default 与具名导出指向同一 meta')
    }

    if (dshModule.meta?.id !== manifest?.id) {
      fail(`dsh meta.id 与清单不一致：${dshModule.meta?.id} vs ${manifest?.id}`)
    } else ok('dsh meta.id 与清单一致')
  } catch (error) {
    fail(`dsh 入口加载失败：${error.message}`)
  }
}

// ---- 4. 内核真源与产物 ----
const esmCorePath = join(bundleDir, 'core.mjs')
const cjsCorePath = join(bundleDir, 'core.cjs')

if (existsSync(esmCorePath) && existsSync(cjsCorePath)) {
  try {
    const coreEsm = await import(pathToFileURL(esmCorePath).href)
    const coreCjs = require(cjsCorePath)

    const expected = ['ID', 'VERSION', 'describe', 'greet', 'markHost', 'snapshot']
    const missing = expected.filter((key) => !(key in coreEsm) || !(key in coreCjs))
    if (missing.length > 0) fail(`内核导出缺失：${missing.join(', ')}`)
    else ok('core.mjs / core.cjs 导出齐全')

    if (coreEsm.ID !== coreCjs.ID || coreEsm.VERSION !== coreCjs.VERSION) {
      fail(`产物版本不一致：${coreEsm.ID}@${coreEsm.VERSION} vs ${coreCjs.ID}@${coreCjs.VERSION}`)
    } else ok(`产物版本一致：${coreEsm.ID}@${coreEsm.VERSION}`)

    const samples = [
      ['describe', () => JSON.stringify(coreEsm.describe()), () => JSON.stringify(coreCjs.describe())],
      ['greet', () => coreEsm.greet('probe'), () => coreCjs.greet('probe')],
      ['markHost', () => coreEsm.markHost('probe'), () => coreCjs.markHost('probe')]
    ]

    const drift = samples.filter(([, fromEsm, fromCjs]) => fromEsm() !== fromCjs())
    if (drift.length > 0) fail(`两份内核行为不一致：${drift.map(([name]) => name).join(', ')}`)
    else ok('两份内核行为一致')
  } catch (error) {
    fail(`内核产物校验失败：${error.message}`)
  }
} else {
  fail('缺少 core.mjs 或 core.cjs，先跑 pnpm petal:build')
}

// ---- 5. dsh 副本 ----
const dshDir = resolve(
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
const mirrored = ['core.mjs', 'index.mjs']
const drifted = []

for (const name of mirrored) {
  const from = join(bundleDir, name)
  const to = join(dshDir, name)
  if (!existsSync(to)) {
    drifted.push(`${name} 缺失`)
    continue
  }
  const a = readFileSync(from, 'utf8').replace(/\r\n/g, '\n')
  const b = readFileSync(to, 'utf8').replace(/\r\n/g, '\n')
  if (a !== b) drifted.push(`${name} 内容不同`)
}

if (drifted.length > 0) {
  fail(`dsh 副本与 bundle 不同步（跑 pnpm petal:sync-dsh）：${drifted.join('，')}`)
} else ok('dsh 副本与 bundle 同步')

// ---- 结果 ----
console.log('')
if (failures.length > 0) {
  for (const message of failures) console.error(`FAIL ${message}`)
  console.log(`PETAL_BUNDLE_FAILED ${failures.length} 项`)
  process.exit(1)
}

console.log('PETAL_BUNDLE_OK')
