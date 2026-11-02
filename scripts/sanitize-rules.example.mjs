/**
 * 脱敏扫描的本机真值配置 —— **模板**，仓库里提交的就是这个文件。
 *
 * 用法：
 *   1. 复制为同目录的 sanitize-rules.local.mjs
 *   2. 把下面的占位值替换为你机器上的真实值
 *   3. sanitize-rules.local.mjs 已在 .gitignore 中，不会被提交
 *
 * ⚠️ 不要把真值填进本文件（example）并提交 —— 那正是这套机制要防的事。
 *
 * 可信来源：
 *   用户名     → echo %USERNAME%
 *   工作区目录 → 你的项目父目录名
 */

export const KNOWN_USERNAMES = [
  'REPLACE_WITH_YOUR_USERNAME',
];

export const WORKSPACE_MARKERS = [
  'REPLACE_WITH_YOUR_WORKSPACE_DIR',
];
