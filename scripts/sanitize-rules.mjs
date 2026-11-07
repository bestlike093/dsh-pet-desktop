/**
 * 脱敏扫描规则 —— 单一来源
 * 供 scripts/sanitize-check.mjs（工作树）与 scripts/history-scan.mjs（git 历史）共用。
 *
 * ⚠️ 真值不写在这里。
 *    本机真值放在同目录的 sanitize-rules.local.mjs（已 gitignore），
 *    仓库里只提交 sanitize-rules.example.mjs（占位符）。
 *    若 local 不存在，回落到 example：此时规则退化为「只查凭据形态」，
 *    history-scan / sanitize-check 会输出 DEGRADED 并以 exit 2 失败，不静默通过。
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const LOCAL = join(here, 'sanitize-rules.local.mjs');
const EXAMPLE = join(here, 'sanitize-rules.example.mjs');

// ---- 真值来源：local 优先，回落 example ----
export const PROFILE_SOURCE = existsSync(LOCAL) ? 'local' : 'example';
// Windows 上 import() 不认裸盘符路径，必须转成 file:// URL
const profile = await import(pathToFileURL(existsSync(LOCAL) ? LOCAL : EXAMPLE).href);

// 回落 example 时，真值规则一律置空 —— 否则会拿「REPLACE_WITH_...」这类占位串去匹配，
// 产生满屏假命中，把真正的凭据命中淹掉。此时只保留 CREDENTIAL_SHAPE 兜底。
const PLACEHOLDER = /^REPLACE_WITH_/;
const clean = arr => (arr ?? []).filter(x => typeof x === 'string' && x && !PLACEHOLDER.test(x));

const users = clean(profile.KNOWN_USERNAMES);
const markers = clean(profile.WORKSPACE_MARKERS);

// 降级判定必须看「实际生效的规则」，不能看「配置文件是否存在」。
// 否则把 example 复制成 local 就能让 DEGRADED=false，
// 而占位串已被剔空 —— 看起来完整，实际只剩凭据兜底。
//
// users / markers 必须是 clean() 之后的值（已剔除 REPLACE_WITH_ 占位串）；
// 直接用 profile.* 会让「复制 example 当 local」重新绕过此判据。
export const DEGRADED = users.length === 0 && markers.length === 0;

export const KNOWN_USERNAMES = users;
export const WORKSPACE_MARKERS = markers;

// ---- 扫描范围 ----
export const TEXT_EXT = new Set([
  '.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.md',
  '.yml', '.yaml', '.toml', '.ini', '.env', '.html', '.css',
  '.txt', '.log', '.ps1', '.cmd', '.bat', '.sh',   // ← 补：脚本与日志
]);

export const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage',
  '.tmp', 'tmp', 'dist-public', 'assets', 'storages', 'runtime',
]);

/**
 * 自扫豁免：规则文件自身必然含真值（或占位符），必须排除，
 * 否则 sanitize-check 永远命中自己 —— 这是「守卫扫到自己」的自指问题。
 */
export const SKIP_FILES = new Set([
  'sanitize-rules.mjs', 'sanitize-rules.local.mjs', 'sanitize-rules.example.mjs',
  'sanitize-check.mjs', 'history-scan.mjs',
  // 假值定义源（A-14b）：必然含 fakeuser / fakeworkspace 字面量，
  // 与 fixture 同理属自扫豁免；不豁免会让「假值单源」本身把 verify 打红。
  'test-fake-names.mjs',
  // 本机运行时上下文：真值只留本地，仓库用 RUNTIME-CONTEXT.example.md
  'RUNTIME-CONTEXT.md',
  // 脱敏规则表自身：必然写着真实工作区名与假 key 字面量，属自扫豁免。
  'export-public.mjs',
  // 定时任务写的运行日志：含本机路径与收件邮箱，*.log 已被 .gitignore 忽略，不进产物。
  // 豁免是为了不让每天 9 点的简报任务把 verify 打红；若将来要连工作树一起干净，应把日志输出改到临时目录。
  'daily-brief.log',
]);

/**
 * 文本文件判定。
 * .gitignore / .env / .npmrc 这类裸扩展名文件，extname 返回空串，必须按 dotfile 单独纳入；
 * .env.local 有两个点，只看最后一段扩展名也会漏，所以 dotfile 一律按文本处理。
 */
export function isTextFile(name) {
  const lower = name.toLowerCase();
  if (lower.startsWith('.')) return true;
  const index = lower.lastIndexOf('.');
  if (index <= 0) return false;
  return TEXT_EXT.has(lower.slice(index));
}

/**
 * 已知测试夹具字面量 —— 显式登记，只在 CREDENTIAL_SHAPE 上生效。
 *
 * 背景：假 key 夹具会让守卫长期报警，而每次都是假的。
 *       报警一直在响、于是没人听 —— 真 key 混进来那天也会被一起跳过（族 D）。
 *       所以不靠"它看起来假"，而是把字面量登记在这里，并写清出处。
 *
 * ⚠️ 入库条件（缺一不入）：
 *   1. 能指出它来自哪个文件、哪条断言；
 *   2. 确认从未作为真实凭据使用过；
 *   3. 确已推送到远程、后续提交删不掉 —— 能直接改掉的，改掉，不要往这里加。
 */
export const KNOWN_FIXTURE_LITERALS = new Set([
  // packages/vault/src/__tests__/serviceSecretStore.test.ts
  // 早期版本用它验证 getMasked 不返回明文；dfc4d0f 已推送，历史不可改写。
  'sk-verysecretvalue123',
  // 同文件早期版本的另一条断言；字面量恰好 16 位，命中 sk- 形态规则。
  'sk-abcdefghijklmnop',
]);

// ---- 规则 ----
export const RULES = [
  {
    id: 'LOCAL_ABS_WIN',
    desc: 'Windows 本地绝对路径',
    re: /[A-Za-z]:\\(?:Users|home\\)[^\s`"'）)，、。；]*/g,
    allow: /<用户名>|<user>|<工作区>|<workspace>|AppData\\Local\\Temp|\$\{|\$\(|%[A-Z_]+%/,
  },
  {
    id: 'LOCAL_ABS_POSIX',
    desc: 'POSIX 本地绝对路径（/home/<user>、/Users/<user>）',
    // alice 是脱敏测试的固定假名样本，不含真值；真用户名仍会被拦
    re: /(?:^|[^\w])(?:\/home\/|\/Users\/)[A-Za-z0-9._-]+[^\s`"'）)，、。；]*/g,
    allow: /<用户名>|<user>|\$\{|\$\(|\/Users\/alice|\/home\/alice/,
  },
  {
    id: 'WORKSPACE_MARKER',
    desc: '本地工作区目录名',
    re: WORKSPACE_MARKERS.length
      ? new RegExp(WORKSPACE_MARKERS.map(m => m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g')
      : /(?!)/g,
    allow: /<工作区>|<workspace>/,
  },
  {
    id: 'KNOWN_USERNAME',
    desc: '已知本机用户名',
    re: KNOWN_USERNAMES.length
      ? new RegExp(`\\b(?:${KNOWN_USERNAMES.join('|')})\\b`, 'g')
      : /(?!)/g,
    allow: /<用户名>|<user>/,
  },
  {
    id: 'CREDENTIAL_SHAPE',
    desc: '疑似凭据形态（兜底，永远生效）',
    re: /\b(?:sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
    // 唯一豁免来源是 KNOWN_FIXTURE_LITERALS（逐条登记），不提供正则式 allow。
    allow: null,
  },
];

/**
 * 对单行文本跑全部规则。
 * @param {string} line
 * @param {Array} rules
 * @returns {{rule:string,desc:string,line:number,hit:string}[]}
 */
export function parseFindingsFromLine(line, rules = RULES) {
  const out = [];
  for (const rule of rules) {
    if (rule.re.source === '(?!)') continue; // 空规则（无真值配置）
    rule.re.lastIndex = 0;
    let m;
    while ((m = rule.re.exec(line)) !== null) {
      const hit = m[0];
      if (rule.allow && rule.allow.test(hit)) continue;
      // 显式登记的假夹具：只对凭据形态生效，其余规则不受影响。
      if (rule.id === 'CREDENTIAL_SHAPE' && KNOWN_FIXTURE_LITERALS.has(hit)) continue;
      out.push({
        rule: rule.id,
        desc: rule.desc,
        line: 0,
        hit: hit.length > 80 ? hit.slice(0, 80) + '…' : hit,
      });
    }
  }
  return out;
}
