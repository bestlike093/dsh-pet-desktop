// 模块边界卡点（计划 1.5）。
//
// 目标只有一条：模块之间不得直接 import。
//
// 为什么单独一个脚本：`check-shared-purity.mjs` 管的是「包之间」的依赖方向，
// 同一个包里的模块互相 import 它看不见。而模块互相 import 会让「一个模块崩了
// 不波及别人」变成空话 —— A 引了 B 的实现，B 改一行，A 跟着变。
//
// 两条规则：
// 1. builtin 模块之间禁止互相 import（要协作走宿主端口 / 事件总线）
// 2. 宿主设施（moduleHost 等）禁止反向 import 具体模块
//
// `--self-test` 注入两个探针：
// - 一个跨模块 import，必须被拦下
// - 一个合法的宿主设施 import，不得误伤
// 只测「会红」会漏掉误伤，只测「会绿」会把永远红的规则当成有效，两边都要测。

import { readFileSync, writeFileSync, unlinkSync, existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const MODULES_DIR = 'packages/core/src/modules'
const BUILTIN_DIR = `${MODULES_DIR}/builtin`
const TEST_PATH_RE = /(^|\/)(__tests__|tests?)\/|\.(test|spec)\.tsx?$/

const IMPORT_RE = /(?:^|[^\w$])(?:import|export)\s+(?:[^'"();]*?\s+from\s+)?['"]([^'"]+)['"]/g
const DYNAMIC_RE = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g

function toPosix(path) {
  return path.replace(/\\/g, '/')
}

function extractSpecifiers(source) {
  const found = []
  for (const re of [IMPORT_RE, DYNAMIC_RE]) {
    re.lastIndex = 0
    let match
    while ((match = re.exec(source)) !== null) found.push(match[1])
  }
  return [...new Set(found)]
}

function walk(dir, out) {
  if (!existsSync(dir)) return
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.tsx?$/.test(name)) out.push(full)
  }
}

/** 把相对 root 的源文件路径与导入说明符，解析成相对 root 的目标路径。 */
function resolveTarget(fromRel, spec) {
  if (!spec.startsWith('.')) return null
  const joined = join(dirname(join(root, fromRel)), spec)
  return toPosix(relative(root, joined))
}

/**
 * 判定一次 import 是否越界。
 * 出 modules 目录的不管（去 shared / core 其他目录是另一层的事）。
 */
function violationFor(fromRel, spec) {
  const target = resolveTarget(fromRel, spec)
  if (target === null) return null
  if (!target.startsWith(`${MODULES_DIR}/`)) return null

  const fromBuiltin = fromRel.startsWith(`${BUILTIN_DIR}/`)
  const toBuiltin = target.startsWith(`${BUILTIN_DIR}/`)

  if (fromBuiltin && toBuiltin) {
    return `${fromRel} → ${target}（模块之间直接 import，应走宿主端口）`
  }
  if (!fromBuiltin && toBuiltin) {
    return `${fromRel} → ${target}（宿主设施反向依赖具体模块）`
  }
  return null
}

function collectSources() {
  const files = []
  walk(join(root, MODULES_DIR), files)
  return files
    .map((full) => toPosix(relative(root, full)))
    .filter((rel) => !TEST_PATH_RE.test(rel))
}

function scan(relPaths) {
  const violations = []
  for (const rel of relPaths) {
    const source = readFileSync(join(root, rel), 'utf8')
    for (const spec of extractSpecifiers(source)) {
      const hit = violationFor(rel, spec)
      if (hit !== null) violations.push(hit)
    }
  }
  return violations
}

const selfTest = process.argv.includes('--self-test')
const probes = []

function injectProbe(rel, content) {
  const full = join(root, rel)
  writeFileSync(full, content)
  probes.push(full)
}

function cleanupProbes() {
  for (const full of probes) {
    if (existsSync(full)) unlinkSync(full)
  }
}

let failed = 0
function line(ok, text) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${text}`)
  if (!ok) failed += 1
}

try {
  const sources = collectSources()
  const violations = scan(sources)

  line(
    violations.length === 0,
    violations.length === 0
      ? `${sources.length} 个模块源码文件无越界导入`
      : `命中 ${violations.length} 处越界导入`
  )
  for (const violation of violations) console.log(`  ${violation}`)

  if (selfTest) {
    // 1. 跨模块 import 必须被拦
    injectProbe(
      `${BUILTIN_DIR}/__boundary_probe_a__.ts`,
      "import { bubbleModule } from './bubble.js'\nexport const probe = bubbleModule\n"
    )
    const crossViolations = scan(collectSources())
    const crossHit = crossViolations.some((item) => item.includes('__boundary_probe_a__'))
    line(crossHit, `自检 跨模块 import 被拦下（hit=${crossHit}）`)
    cleanupProbes()
    probes.length = 0

    // 2. 宿主设施 import 不得误伤
    injectProbe(
      `${BUILTIN_DIR}/__boundary_probe_b__.ts`,
      "import type { SandboxModuleContext } from '../moduleSandbox.js'\nexport type Probe = SandboxModuleContext\n"
    )
    const hostViolations = scan(collectSources())
    const hostHit = hostViolations.some((item) => item.includes('__boundary_probe_b__'))
    line(!hostHit, '自检 合法的宿主设施 import 未被误伤（放行验证）')
    cleanupProbes()
    probes.length = 0

    if (failed > 0) {
      console.log('MODULE_BOUNDARIES_SELFTEST_FAILED')
      process.exitCode = 2
    } else {
      console.log('PASS 自检探针全部符合预期')
      console.log('MODULE_BOUNDARIES_SELFTEST_OK')
      process.exitCode = 0
    }
  } else if (failed > 0) {
    console.log('MODULE_BOUNDARIES_FAILED')
    process.exitCode = 1
  } else {
    console.log('MODULE_BOUNDARIES_OK')
  }
} finally {
  cleanupProbes()
}
