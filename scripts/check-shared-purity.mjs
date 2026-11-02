// 包纯净度卡点（§16.2 方案 A，已扩为「一个脚本 + 按包策略表」）。
//
// 文件名保留 `check-shared-purity.mjs` 是为了不动 verify 调用点；
// 实际扫描的是下面 POLICIES 里的每一个包。
//
// 为什么不是一刀切：ui 是第一个允许碰 DOM 的包。
// 若直接把 ui 塞进 shared 的规则，document 满屏全红；
// 若因此把 DOM 也加进豁免，ui 就成了「看起来被检查、实际没人管」的包 —— 比不检查更糟。
//
// 每个包独立的四条检查：
// 1. package.json 运行时依赖必须在白名单内 —— 依赖方向靠清单守，比逐行 import 牢
// 2. 源码不得 import electron / pixi / node:* / Node 内建（所有包，无例外）
// 3. 源码不得 import 白名单外的 @pet/* 包（反向依赖 / 循环）
// 4. 源码 DOM 全局：按策略，shared 禁，ui 许
//
// `--self-test` 会注入三个探针并断言：
// - shared 的 electron + window 被拦下
// - ui 的 electron 被拦下
// - ui 的 document 不被误伤（放行验证）
// 只测「会红」不测「会绿」，就会把一条永远红的规则当成有效。

import { readFileSync, writeFileSync, unlinkSync, existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 按包策略。新增包时在这里加一项，不要复制第二个脚本。
 *
 * allowDomGlobals: 该包是否允许 window / document 作为表达式主语
 * allowedWorkspaceDeps: 允许出现的 @pet/* 运行时依赖（空 = 一个都不许）
 * allowedExternal: 允许出现的非 workspace 运行时依赖（devDependencies 不检查）
 */
const POLICIES = [
  {
    id: 'shared',
    srcDir: 'packages/shared/src',
    pkg: 'packages/shared/package.json',
    allowDomGlobals: false,
    allowedWorkspaceDeps: [],
    allowedExternal: ['vitest'],
  },
  {
    id: 'ui',
    srcDir: 'packages/ui/src',
    pkg: 'packages/ui/package.json',
    allowDomGlobals: true, // 骨架本来就该用 DOM
    allowedWorkspaceDeps: ['@pet/shared', '@pet/core'],
    allowedExternal: [],
    // 只允许在 __tests__ / *.test.ts 里出现；生产代码不许依赖测试框架
    testOnlyExternal: ['vitest'],
  },
]

const NODE_BUILTINS = new Set([
  'assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console', 'constants',
  'crypto', 'dgram', 'diagnostics_channel', 'dns', 'domain', 'events', 'fs', 'http',
  'http2', 'https', 'inspector', 'module', 'net', 'os', 'path', 'perf_hooks', 'process',
  'punycode', 'querystring', 'readline', 'repl', 'stream', 'string_decoder', 'timers',
  'tls', 'trace_events', 'tty', 'url', 'util', 'v8', 'vm', 'wasi', 'worker_threads', 'zlib'
])

const DOM_GLOBALS = ['window', 'document']

// 平台/宿主相关：所有包都禁，没有例外
const HOST_PACKAGES = ['electron', '@electron', 'pixi.js', 'pixi', '@pixi', 'jsdom', 'canvas', 'sharp']

const WORKSPACE_SCOPE = '@pet/'

/** 测试文件判定：只有这些路径才允许 import 测试框架。 */
const TEST_PATH_RE = /(^|\/)(__tests__|tests?)\/|\.(test|spec)\.tsx?$/

function isTestPath(where) {
  return TEST_PATH_RE.test(where)
}

const IMPORT_RE = /(?:^|[^\w$])(?:import|export)\s+(?:[^'"();]*?\s+from\s+)?['"]([^'"]+)['"]/g
const DYNAMIC_RE = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g
const REQUIRE_RE = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g

function extractSpecifiers(source) {
  const found = []
  for (const re of [IMPORT_RE, DYNAMIC_RE]) {
    re.lastIndex = 0
    let match
    while ((match = re.exec(source)) !== null) found.push(match[1])
  }
  return [...new Set(found)]
}

function packageNameOf(spec) {
  if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:')) return null
  const parts = spec.split('/')
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

function matchesHostPackage(pkg) {
  return HOST_PACKAGES.some((name) => pkg === name || pkg.startsWith(`${name}/`))
}

function walk(dir, out) {
  if (!existsSync(dir)) return
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(ts|tsx)$/.test(name)) out.push(full)
  }
}

function checkDomGlobals(files, policy) {
  const violations = []
  const skipped = []
  if (policy.allowDomGlobals) return { violations, skipped, skippedByPolicy: true }

  for (const file of files) {
    const source = readFileSync(file, 'utf8')
    const where = relative(root, file).replace(/\\/g, '/')

    for (const name of DOM_GLOBALS) {
      if (new RegExp(`\\b(?:const|let|var)\\s+${name}\\b`).test(source)) {
        skipped.push(`${where} 声明了局部 ${name}，跳过该项`)
        continue
      }

      // 前面是标识符、$ 或 . ⇒ 不是全局访问；后面必须接 . 或 [ 才算读取成员。
      if (new RegExp(`(?<![\\w$.])${name}\\s*[.[]`).test(source)) {
        violations.push(`${where} 访问了 DOM 全局 ${name}`)
      }
    }
  }

  return { violations, skipped, skippedByPolicy: false }
}

function checkImports(files, policy) {
  const violations = []

  for (const file of files) {
    const source = readFileSync(file, 'utf8')
    const where = relative(root, file).replace(/\\/g, '/')

    for (const spec of extractSpecifiers(source)) {
      if (spec.startsWith('node:')) {
        violations.push(`${where} 导入 ${spec}（Node 内建）`)
        continue
      }
      if (NODE_BUILTINS.has(spec)) {
        violations.push(`${where} 导入 ${spec}（Node 内建）`)
        continue
      }
      if (spec.startsWith('.')) continue

      const pkg = packageNameOf(spec)
      if (pkg === null) continue

      if (matchesHostPackage(pkg)) {
        violations.push(`${where} 导入 ${spec}（宿主/渲染平台依赖）`)
        continue
      }

      if (pkg.startsWith(WORKSPACE_SCOPE)) {
        if (!policy.allowedWorkspaceDeps.includes(pkg)) {
          violations.push(`${where} 导入 ${spec}（反向或越界依赖，白名单外）`)
        }
        continue
      }

      if (policy.allowedExternal.includes(pkg)) continue
      // 测试框架只在测试路径放行：生产代码依赖测试框架同样不应该。
      if (isTestPath(where) && (policy.testOnlyExternal ?? []).includes(pkg)) continue

      violations.push(`${where} 导入 ${spec}（外部依赖，白名单外）`)
    }

    // require() 在 ESM 包里出现即是异常，不受白名单保护
    REQUIRE_RE.lastIndex = 0
    if (REQUIRE_RE.test(source)) {
      violations.push(`${where} 使用了 require()，本包是纯 ESM`)
    }
  }

  return { violations, scanned: files.length }
}

function checkDependencies(policy) {
  const pkgPath = join(root, policy.pkg)
  if (!existsSync(pkgPath)) return [`${policy.pkg} 不存在`]

  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  const violations = []
  const allowed = new Set([...policy.allowedWorkspaceDeps, ...policy.allowedExternal])

  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    const deps = pkg[field]
    if (deps === undefined) continue
    for (const name of Object.keys(deps)) {
      if (!allowed.has(name)) violations.push(`${field} 含 ${name}（白名单外）`)
    }
  }
  return violations
}

function collectFiles(policy) {
  const files = []
  walk(join(root, policy.srcDir), files)
  return files
}

const selfTest = process.argv.includes('--self-test')
const probes = []

function injectProbe(policy, name, content) {
  const path = join(root, policy.srcDir, name)
  writeFileSync(path, content)
  probes.push(path)
  return path
}

function cleanupProbes() {
  for (const path of probes) {
    if (existsSync(path)) unlinkSync(path)
  }
}

try {
  let failed = 0
  function line(ok, text) {
    console.log(`${ok ? 'PASS' : 'FAIL'} ${text}`)
    if (!ok) failed += 1
  }

  for (const policy of POLICIES) {
    const files = collectFiles(policy)

    const depViolations = checkDependencies(policy)
    const { violations: importViolations } = checkImports(files, policy)
    const { violations: domViolations, skipped: domSkipped } = checkDomGlobals(files, policy)

    line(
      depViolations.length === 0,
      depViolations.length === 0
        ? `${policy.id}: package.json 运行时依赖在白名单内`
        : `${policy.id}: package.json 依赖越界：${depViolations.join('；')}`
    )

    line(
      importViolations.length === 0,
      importViolations.length === 0
        ? `${policy.id}: ${files.length} 个文件无宿主/越界依赖`
        : `${policy.id}: 命中 ${importViolations.length} 处违规导入`
    )
    for (const violation of importViolations) console.log(`  ${violation}`)

    line(
      domViolations.length === 0,
      domViolations.length === 0
        ? policy.allowDomGlobals
          ? `${policy.id}: DOM 全局按策略放行`
          : `${policy.id}: 无 DOM 全局访问`
        : `${policy.id}: 命中 ${domViolations.length} 处 DOM 全局访问`
    )
    for (const violation of domViolations) console.log(`  ${violation}`)
    for (const note of domSkipped) console.log(`  SKIP ${note}`)
  }

  if (selfTest) {
    const sharedPolicy = POLICIES.find((p) => p.id === 'shared')
    const uiPolicy = POLICIES.find((p) => p.id === 'ui')

    // 1. shared：宿主 API + DOM 都必须被拦
    injectProbe(
      sharedPolicy,
      '__shared_purity_probe__.ts',
      "import { app } from 'electron'\nexport const probe = app\nexport const width = window.innerWidth\n"
    )
    const sharedFiles = collectFiles(sharedPolicy)
    const sharedImports = checkImports(sharedFiles, sharedPolicy).violations
    const sharedDom = checkDomGlobals(sharedFiles, sharedPolicy).violations
    const sharedProbeHit = sharedImports.some((item) => item.includes('__shared_purity_probe__'))
    const sharedDomHit = sharedDom.some((item) => item.includes('__shared_purity_probe__'))
    line(
      sharedProbeHit && sharedDomHit,
      `自检 shared 探针被拦下（import=${sharedProbeHit}，dom=${sharedDomHit}）`
    )
    cleanupProbes()
    probes.length = 0

    // 2. ui：宿主 API 必须被拦
    injectProbe(
      uiPolicy,
      '__ui_host_probe__.ts',
      "import { ipcRenderer } from 'electron'\nexport const probe = ipcRenderer\n"
    )
    const uiHostFiles = collectFiles(uiPolicy)
    const uiHostImports = checkImports(uiHostFiles, uiPolicy).violations
    const uiHostHit = uiHostImports.some((item) => item.includes('__ui_host_probe__'))
    line(uiHostHit, `自检 ui 宿主 API 探针被拦下（hit=${uiHostHit}）`)
    cleanupProbes()
    probes.length = 0

    // 3. ui：document 不得被误伤（放行验证）
    injectProbe(
      uiPolicy,
      '__ui_dom_probe__.ts',
      "export const node = document.createElement('div')\n"
    )
    const uiDomFiles = collectFiles(uiPolicy)
    const uiDomImports = checkImports(uiDomFiles, uiPolicy).violations
    const uiDomViolations = checkDomGlobals(uiDomFiles, uiPolicy).violations
    const uiDomProbeHit =
      uiDomViolations.some((item) => item.includes('__ui_dom_probe__')) ||
      uiDomImports.some((item) => item.includes('__ui_dom_probe__'))
    line(!uiDomProbeHit, '自检 ui 的 document 未被误伤（放行验证）')
    cleanupProbes()
    probes.length = 0

    if (failed > 0) {
      console.log('SHARED_PURITY_SELFTEST_FAILED')
      process.exitCode = 2
    } else {
      console.log('PASS 自检探针全部符合预期')
      console.log('SHARED_PURITY_SELFTEST_OK')
      process.exitCode = 0
    }
  } else if (failed > 0) {
    console.log('SHARED_PURITY_FAILED')
    process.exitCode = 1
  } else {
    console.log('SHARED_PURITY_OK')
  }
} finally {
  cleanupProbes()
}
