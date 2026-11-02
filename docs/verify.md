# verify 门禁与快照口径（2026-11-02）

## 一次验证跑什么

`pnpm verify` 依次执行：workspace 构建 → 类型检查 → 14 个前置门禁脚本 → `contract-snapshot.mjs` → `verify.mjs` 汇总门。完整清单以根 `package.json` 的 `verify` 字段为准。

关键步骤：

| 步骤 | 脚本 | 当前判据 |
| --- | --- | --- |
| 语法 | `scripts/check-electron-syntax.mjs` | 34 个 Electron 文件可解析 |
| 素材许可 | `scripts/check-assets-license.mjs` | `ASSETS_LICENSE_OK` |
| IPC 契约 | `scripts/check-ipc-contract.mjs` | 白名单 / 注册 / preload 各 70 条 |
| i18n | `scripts/check-i18n-coverage.mjs --strict` | 缺失 key 0 / 中文残留 0 / 字典不对称 0 |
| 写死色值 | `scripts/check-hex-colors.mjs --strict` | 裸用 0；token 只在 `theme.css` 定义 |
| 图片体积 | `scripts/check-image-size.mjs --strict --warn-only` | 超 512KB 0 张；跑稳后去掉 `--warn-only` |
| 契约快照 | `scripts/contract-snapshot.mjs` | 95 条契约未漂移 |
| 汇总 | `scripts/verify.mjs` | 依赖方向、浏览器入口、dist 体积、密钥与脱敏扫描、11 组冒烟；输出 `P6_GATE_OK` |

## 快照口径

- 仓库没有五窗口像素快照基线，也没有截图 diff 流水线。
- 视觉改动的验收以 `contract-snapshot` 的 **95 条契约**为准：契约不变即视为未漂移。
- 没有像素基线时，提交说明不写「快照无差异」，改写「契约 95 条未漂移」；肉眼可见的变化单独注明。
- 导出契约常量（如 `window-bounds` 的 `DOCK_MARGIN`）改值必须同步快照与用例，不能只改常量；当前 24 由测试与契约快照共同锁定。

## 位置断言与删减冒烟

- 任何「包内某路径恰好 N 处」的断言，必须附一次删减冒烟：临时重命名该路径，确认冒烟行为发生变化；只数目录数不算证据。
- 本次 @pet 删减冒烟（2026-11-02）：`sinkB` 是 HARD，删后 `packages/core/dist/assets` 解析 `@pet/shared` 报 `MODULE_NOT_FOUND`；`sinkA` 是 SOFT，删后 `apps/desktop/dist` 解析 `@pet/core` 回落 `sinkB` 仍成功。断言保持两处都在并分别标 HARD / SOFT；resolver 收敛方向是让 `sinkA` 消费方改走 `sinkB`。

## 已知收敛

- 2026-11-02：禁用态透明度原本散在 0.45 / 0.5 / 0.55 / 0.6 四档，收敛为 `--disabled-opacity`（0.5）与 `--disabled-opacity-strong`（0.6）两档。聊天发送键（0.45）与引导页两处（0.55）视觉上略加深，属有意收敛，不是漂移。
