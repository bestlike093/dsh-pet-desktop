/**
 * 假值域单一来源（A-14b）
 *
 * 三域模型（戊组 / 丙组 2026-10-31 定）：
 *   真值域：scripts/sanitize-rules.local.mjs —— gitignore，永不提交，已单源，不并入本文件
 *   假值域：本文件 + scripts/sanitize-check.fixture/sample.md —— 必须提交，A-14b 的对象
 *   形态域：packages/core/src/diagnostics/copyReport.ts —— 纯正则，禁止引入名单
 *
 * ⛔ 硬边界：
 *   1. 真值（本机用户名 / 工作区名）不得写进本文件。
 *   2. `alice` 不进名单 —— 它是「裸用户名不该被路径脱敏替换」的设计边界反例，
 *      不是假值。把它收进来会把一条设计边界改写成特例。
 *   3. fixture 内容必须与 TEST_FAKE_VALUES 完全一致；任一侧漂移，
 *      `sanitize-check.mjs --self-test` 与常规扫描都会先红。
 */

export const TEST_FAKE_NAMES = Object.freeze({
  /** Windows 路径里的用户目录段 */
  username: 'fakeuser',
  /** 工作区目录名占位 */
  workspace: 'fakeworkspace',
  /** 凭据形态兜底规则用的假 token，前缀必须是 sk-FAKE 以便人工辨认 */
  credential: 'sk-FAKE1234567890ABCDEF'
})

export const TEST_FAKE_VALUES = Object.freeze(Object.values(TEST_FAKE_NAMES))
