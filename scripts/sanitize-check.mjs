#!/usr/bin/env node
/**
 * 发布前脱敏检查（工作树）—— 与 llm-key-scan / check-browser-entry 同级，并入 scripts/verify.mjs
 *
 * 注意：本脚本**只扫工作树，不扫 git 历史**。
 *       已推送的内容扫不到也删不掉，历史部分请用 scripts/history-scan.mjs。
 *
 * 用法：
 *   node scripts/sanitize-check.mjs [rootDir]
 *   node scripts/sanitize-check.mjs --self-test   # 只验规则是否仍会拦
 *   node scripts/sanitize-check.mjs --verbose     # 展开全部命中
 * 退出码：0 = PASS，1 = 命中泄漏，2 = DEGRADED（缺真值配置）
 *
 * 规则来自 scripts/sanitize-rules.mjs（与 history-scan 共用，单一来源）。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RULES, SKIP_DIRS, SKIP_FILES, DEGRADED, PROFILE_SOURCE, KNOWN_USERNAMES,
  isTextFile, parseFindingsFromLine,
} from './sanitize-rules.mjs';
import { TEST_FAKE_VALUES } from './test-fake-names.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = resolve(HERE, 'sanitize-check.fixture');
const selfTest = process.argv.includes('--self-test');
const verbose = process.argv.includes('--verbose');

// 缺真值配置必须显式失败：只 warn 再继续，findings 为 0 时就会退出 0，
// 那是一个不受用户名 / 工作区规则保护的假 PASS。
//
// CI 例外：真值属本机信息、不入仓，CI 上必然 DEGRADED。
// 设置 DEGRADED_OK=1 后放行，但输出里必须写明「不等于完整检查」，
// 避免把「只跑了凭据形态」当成「全量通过」。
if (DEGRADED) {
  console.error('[sanitize-check] DEGRADED：未找到 sanitize-rules.local.mjs');
  console.error('                 用户名 / 工作区规则已停用，仅凭据形态兜底生效。');
  console.error('                 这不是 PASS。复制 sanitize-rules.example.mjs 为 .local.mjs 并填真值后重跑。');
  if (process.env.DEGRADED_OK !== '1') {
    process.exit(2);
  }
  console.error('[sanitize-check] DEGRADED_OK=1：以凭据兜底模式继续。');
  console.error('                 本次结果不等于完整检查：用户名 / 工作区规则未生效。');
}

function scan(dir, { skipFixture = true } = {}) {
  const root = resolve(dir);
  const findings = [];

  function walk(current, depth = 0) {
    if (depth > 12) return;
    let entries;
    try { entries = readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (SKIP_DIRS.has(e.name)) continue;
      // 构建/打包输出（dist、dist-verify、dist-nsis-verify、dist-pkg…）天然带本机路径，
      // 它们不是源码，也不进入版本库；统一按前缀跳过，避免每次打包都把门禁打红。
      if (e.isDirectory() && e.name.startsWith('dist')) continue;
      const full = join(current, e.name);
      if (skipFixture && full.startsWith(FIXTURE_DIR)) continue;
      if (e.isDirectory()) { walk(full, depth + 1); continue; }
      if (!e.isFile()) continue;
      if (SKIP_FILES.has(basename(e.name))) continue;   // 自扫豁免
      if (!isTextFile(e.name)) continue;
      // *.log 已在 .gitignore 里，且打包/测试日志天然带本机绝对路径与用户名；
      // 它们不进入版本库与安装包，扫日志只会让门禁被本机调试产物反复打红。
      if (e.name.endsWith('.log')) continue;
      let text;
      try { text = readFileSync(full, 'utf8'); } catch { continue; }
      text.split(/\r?\n/).forEach((line, i) => {
        for (const f of parseFindingsFromLine(line, RULES)) {
          findings.push({ ...f, file: relative(root, full), line: i + 1 });
        }
      });
    }
  }

  walk(root);
  return findings;
}

function printFindings(findings) {
  const byRule = new Map();
  for (const f of findings) {
    if (!byRule.has(f.rule)) byRule.set(f.rule, []);
    byRule.get(f.rule).push(f);
  }
  for (const [rule, items] of byRule) {
    console.error(`  ${rule}（${items[0].desc}） × ${items.length}`);
    const shown = verbose ? items : items.slice(0, 10);
    for (const it of shown) {
      console.error(`    ${it.file}:${it.line}  →  ${it.hit}`);
    }
    if (!verbose && items.length > 10) console.error(`    … 另有 ${items.length - 10} 处（--verbose 展开）`);
    console.error('');
  }
}

// A-14b：fixture 与 TEST_FAKE_NAMES 必须同源。
// 任一侧改了值而另一侧没跟上，这里先红 —— 这才是「单源」的验收判据。
const fixturePath = join(FIXTURE_DIR, 'sample.md');
let fixtureText = '';
try {
  fixtureText = readFileSync(fixturePath, 'utf8');
} catch (e) {
  console.error(`[sanitize-check] 自检失败：读不到 fixture（${fixturePath}）`);
  process.exit(1);
}
// 断言用严格 token 边界，不用 includes。
// includes 挡不住「加后缀」这类漂移：fakeuserX 里含 fakeuser，子串匹配会放过它。
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const hasToken = (text, v) => new RegExp(`(?<![\\w-])${escapeRe(v)}(?![\\w-])`).test(text);
const missingFake = TEST_FAKE_VALUES.filter((v) => !hasToken(fixtureText, v));
if (missingFake.length > 0) {
  console.error('[sanitize-check] 自检失败：fixture 与 TEST_FAKE_NAMES 漂移');
  for (const v of missingFake) console.error(`                 fixture 缺：${v}`);
  console.error('                 改 scripts/test-fake-names.mjs 或 sample.md，二者必须一致。');
  process.exit(1);
}

// 反向：fixture 里不得出现「以假值开头但不是假值」的近似 token（如 fakeuserX）。
// 不加这条，加后缀就能绕过同源检查。
const nearMiss = TEST_FAKE_VALUES
  .map((v) => new RegExp(`(?<![\\w-])${escapeRe(v)}[\\w-]+`, 'g'))
  .flatMap((re) => fixtureText.match(re) ?? []);
if (nearMiss.length > 0) {
  console.error('[sanitize-check] 自检失败：fixture 出现假值的近似变体');
  for (const v of [...new Set(nearMiss)]) console.error(`                 疑似漂移：${v}`);
  process.exit(1);
}

// 反向验证（D-2）：真值规则必须仍会拦本机用户名。
// 名单被写宽（把真值一起豁免掉）时，这里先红。
if (!DEGRADED && KNOWN_USERNAMES.length > 0) {
  const probe = `C:\\Users\\${KNOWN_USERNAMES[0]}\\AppData`;
  const hit = parseFindingsFromLine(probe, RULES)
    .some((f) => f.rule === 'KNOWN_USERNAME' || f.rule === 'LOCAL_ABS_WIN');
  if (!hit) {
    console.error('[sanitize-check] 反向验证失败：本机用户名不再命中，规则名单被写宽');
    console.error(`                 探针：C:\\Users\\<本机用户名>\\AppData`);
    process.exit(1);
  }
}

// 常驻自检：fixture 必须命中。规则被改坏时这里先红。
// fixture 只用明显假名与假 token，不含任何真值。
const fixtureHits = scan(FIXTURE_DIR, { skipFixture: false });

if (selfTest) {
  if (fixtureHits.length === 0) {
    console.error('[sanitize-check] 自检失败：fixture 未命中，规则已失效');
    process.exit(1);
  }
  console.log(`[sanitize-check] 自检通过：fixture 命中 ${fixtureHits.length} 处`);
  printFindings(fixtureHits);
  process.exit(0);
}

if (fixtureHits.length === 0) {
  console.error('[sanitize-check] 自检失败：fixture 未命中，规则已失效');
  process.exit(1);
}

const root = process.argv.slice(2).find((arg) => !arg.startsWith('--')) || '.';
console.log('[sanitize-check] 扫描根目录:', root);
console.log('[sanitize-check] 真值来源:', PROFILE_SOURCE);
const findings = scan(root);

if (findings.length === 0) {
  console.log('[sanitize-check] PASS：工作树未发现本地路径 / 用户名 / 凭据泄漏');
  console.log('  提醒：历史部分请另跑 node scripts/history-scan.mjs origin/main..HEAD');
  process.exit(0);
}

console.error(`\n[sanitize-check] FAIL：命中 ${findings.length} 处\n`);
printFindings(findings);
console.error('处置：替换为 <用户名> / <工作区> 占位符，或在 sanitize-rules.mjs 的 allow 中登记豁免并写明理由。');
process.exit(1);
