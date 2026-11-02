#!/usr/bin/env node
/**
 * 推送前 git 历史敏感信息扫描 —— 与 sanitize-check.mjs 共用同一套规则
 *
 * 背景：工作树扫描（llm-key-scan / sanitize-check）扫不到 git 历史。
 *       已推送的内容无法用后续提交删除，必须在推送前拦截。
 *
 * 用法：
 *   node scripts/history-scan.mjs              # 扫全部历史（git log --all -p）
 *   node scripts/history-scan.mjs origin/main..HEAD   # 只扫待推送区间（快，推荐）
 *
 * 退出码：0 = PASS，1 = 命中泄漏，2 = DEGRADED（缺真值配置）
 *
 * 依赖：需要本机 git 可用。规则来自 scripts/sanitize-rules.mjs（单一来源）。
 */
import { execFileSync } from 'node:child_process';
import { RULES, DEGRADED, PROFILE_SOURCE, SKIP_FILES, parseFindingsFromLine } from './sanitize-rules.mjs';

// 缺真值配置必须显式失败，否则用户规则不生效时历史扫描会给出假 PASS。
if (DEGRADED) {
  console.error('[history-scan] DEGRADED：未找到 sanitize-rules.local.mjs');
  console.error('               用户名 / 工作区规则已停用，仅凭据形态兜底生效。');
  console.error('               这不是 PASS。复制 sanitize-rules.example.mjs 为 .local.mjs 并填真值后重跑。');
  process.exit(2);
}

const range = process.argv[2] || '--all';

function git(...args) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 256,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

// 用 -m 保证 merge commit 也有输出；-p 输出补丁
const args = range === '--all'
  ? ['log', '--all', '-p', '-m', '--pretty=format:@@COMMIT@@ %H %ad %an', '--date=short']
  : ['log', '-p', '-m', '--pretty=format:@@COMMIT@@ %H %ad %an', '--date=short', range];

let out;
try {
  out = git(...args);
} catch (e) {
  console.error('[history-scan] git log 执行失败：', e.message);
  console.error('  若是区间不存在，先确认 ref 有效：git rev-parse --verify <ref>');
  process.exit(1);
}

const lines = out.split(/\r?\n/);
const findings = [];
let curCommit = '(unknown)';
let curFile = '';

for (const line of lines) {
  if (line.startsWith('@@COMMIT@@ ')) {
    curCommit = line.slice('@@COMMIT@@ '.length).trim();
    continue;
  }
  // diff 头给出当前文件，用于跳过自检 fixture（假值，不是真值）
  if (line.startsWith('+++ b/')) {
    curFile = line.slice(6);
    continue;
  }
  if (line.startsWith('+++ /dev/null')) {
    curFile = '';
    continue;
  }
  if (curFile.includes('sanitize-check.fixture/')) continue;
  // 与工作树扫描共用同一份 SKIP_FILES（A-39）：
  // 假值定义源（test-fake-names.mjs）、本机运行时上下文、规则文件自身，
  // 历史上都会被提交过，但它们的内容按设计就是假值/占位符，不是真泄漏。
  // 只豁免文件名（basename），不做路径前缀匹配，避免误放行同名的真实文件。
  const baseName = curFile.slice(curFile.lastIndexOf('/') + 1);
  if (SKIP_FILES.has(baseName)) continue;
  // 只看新增行（+ 开头），删除行说明已经修掉了，不算命中
  if (!line.startsWith('+') || line.startsWith('+++')) continue;
  const content = line.slice(1);
  for (const f of parseFindingsFromLine(content, RULES)) {
    findings.push({ ...f, file: `${curCommit} ${curFile}` });
  }
}

console.log('[history-scan] 扫描区间:', range);
console.log('[history-scan] 真值来源:', PROFILE_SOURCE);

if (findings.length === 0) {
  console.log('[history-scan] PASS：历史中未发现路径 / 用户名 / 凭据泄漏');
  process.exit(0);
}

console.error(`\n[history-scan] FAIL：命中 ${findings.length} 处\n`);

const byRule = new Map();
for (const f of findings) {
  if (!byRule.has(f.rule)) byRule.set(f.rule, []);
  byRule.get(f.rule).push(f);
}

for (const [rule, items] of byRule) {
  console.error(`  ${rule}（${items[0].desc}） × ${items.length}`);
  const shown = items.slice(0, 8);
  for (const it of shown) {
    console.error(`    ${it.file}`);
    console.error(`      :${it.line}  →  ${it.hit}`);
  }
  if (items.length > 8) console.error(`    … 另有 ${items.length - 8} 处`);
  console.error('');
}

// 分级处置提示
const hasSecret = findings.some(f => f.rule === 'CREDENTIAL_SHAPE');
console.error('处置：');
if (hasSecret) {
  console.error('  ⚠️ 检出疑似凭据明文 —— 立即去服务端吊销该 key，再重写历史。');
  console.error('     顺序不能反：重写之前它已经被看见了。');
  console.error('     重写：git filter-repo --replace-text <(每行 "字面量==>***REMOVED***")');
} else {
  console.error('  · 仅路径 / 用户名命中：');
  console.error('     保持 private → 可接受，无需重写');
  console.error('     转 public 前 → 必须重写历史（git filter-repo --replace-text）');
}
console.error('    根治：含本机真值的文件改为 .gitignore + *.example.* 入库');
process.exit(1);
