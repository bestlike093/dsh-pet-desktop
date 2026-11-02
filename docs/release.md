# 发布通道（2026-11-02）

## 两条通道

| 通道 | 命令 | 输出 | sourcemap |
| --- | --- | --- | --- |
| 正式包 | `pnpm package:dir` | `dist-pkg/` | 禁止（构建不带 `--sourceMap`） |
| 调试包 | `pnpm package:debug` | `dist-pkg-debug/` | 允许，构建时显式 `--sourceMap` |

两条通道各自先构建再打包，互不覆盖。正式包的 sourcemap 防线是「构建不带 `--sourceMap`」加 `check-package` ⑧ 断言，不靠 `files` 静默过滤；调试包因此能原样带上 map。

## 校验和

- 打包完成后生成 `dist-pkg*/win-unpacked/resources/checksums-sha256.txt`，范围锁 `resources/app`。
- 文件随包分发，`dist-pkg/` 与 `dist-pkg-debug/` 都不进 git。
- `check:package` 会重算每个文件并逐行比对，作为可复现断言。

## 签名

不适用。当前 `win.target` 为 `dir`、`forceCodeSigning: false`，没有安装包签名，也没有 `latest.yml`。

## 永不进包

任何通道、任何开关下都不进包：

- `assets-gen/`（白底未抠源图）
- `PLACEHOLDER*`
- `*.log`、`*.tsbuildinfo`

正式包额外禁止 `*.map`。

## 声明层剔除

以下包只服务构建工具链，运行时不 `require`，在 `electron-builder.yml` 的 `files` 中显式排除：

`lodash`、`gh-pages`、`qs`、`fs-extra`、`async`

`gh-pages` 来自 `pixi-live2d-display` 上游写进 `dependencies` 的声明，源码运行时不加载。

- **upstream TODO**：这是上游声明错误，不是本仓漏剔。待 `pixi-live2d-display` 修正后从排除名单移除。

## @pet 的两处位置

包内保留两处，用途不同（见 `scripts/after-pack.cjs`）：

- `resources/app/apps/desktop/node_modules/@pet`：供 `apps/desktop/dist/*.js` 的裸名导入。
- `resources/app/node_modules/@pet`：供 `packages/*/dist/*.js` 的裸名导入；主进程用相对路径加载 `packages/core/dist` 后，内部 `@pet/shared` 会向上解析到这一层。

删减冒烟（2026-11-02）：`sinkB` 是 HARD——删后 `packages/core/dist/assets` 解析 `@pet/shared` 直接 `MODULE_NOT_FOUND`；`sinkA` 是 SOFT——删后 `apps/desktop/dist` 解析 `@pet/core` 回落 `sinkB` 仍成功。断言保持两处都在，并分别标 HARD / SOFT。

`electron-builder.yml` 不再重复声明 `node_modules/@pet/**`，同一路径只由 afterPack 写一次。

## 后续立项：resolver 收敛

`@pet` 目前是「单来源双落点」。要收敛成单落点，前提二选一：

1. `core dist` 自包含 `@pet`（构建时内联依赖）；
2. 统一走 `package.json` 的 `imports` 字段。

入口 `scripts/after-pack.cjs`；删减冒烟规则见 `docs/verify.md`。

## 调试包预留

`devtools` 不放进 `--include-debug`，后续用独立 flag；当前不提供假开关。
