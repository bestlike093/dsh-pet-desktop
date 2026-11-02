# 框架差异盘点（2026-11-02）

> 对照对象：`projects/dsh-pet-framework`（上游框架，`feat/b2`，工作区有大量未提交完成品）
> 主改动仓库：`projects/desktop-pet`
> 用途：决定本轮 P4 与安装包之前，哪些框架已完成部分需要移植，哪些只需保持可回移。

---

## 一、盘点方法

1. 读取两侧同一路径的共享实现，避免只看目录名判断。
2. 读取框架 `README.md` 的「现在能做什么」与 desktop-pet `docs/SSOT.md` 的已完成条目。
3. 读取框架工作区的 `git diff --stat` 与未跟踪文件，确认「已完成但未提交」的实际范围。
4. 按四类标记：
   - `must`：不移植会导致 P4 或安装包无法运行 / 明显回归；
   - `optional`：框架有、desktop-pet 没有，但不阻塞本轮；
   - `not-applicable`：框架旧结构，与 desktop-pet 当前产品方向冲突；
   - `desktop-ahead`：desktop-pet 已领先，禁止反向覆盖。

框架工作区现状（只读核对）：

- HEAD `f7ce877`，分支 `feat/b2`，本地领先远端 1 个提交。
- 未提交 42 个文件：28 个已跟踪修改、14 个未跟踪新增。
- 未跟踪新增包括 `apps/desktop/electron/models.mjs`、`renderer/petals/dyad-pet/*`、`renderer/settings.*`、`renderer/vendor/*`、`packages/core/src/media/ttsProvider.ts` 等。
- 框架自己的每日简报写明：门禁未通过（dist 超限、脱敏扫描失败、p3 两项失败），工作区没有回滚锚点。

---

## 二、能力矩阵

| 能力 | 框架证据 | desktop-pet 证据 | 判定 | 说明 |
| --- | --- | --- | --- | --- |
| 设置页信息架构 | `renderer/settings.html` 单页 section 流 | `renderer/settings.html` 10 面板 + i18n + 导航 | `desktop-ahead` | 框架是早期单页原型；不能反向覆盖 desktop-pet 的多面板结构。P4 只在 desktop-pet 上做 6 项一级导航。 |
| 设置即时保存 / 广播 | `settings.js` + `preload.cjs` `onSettingsChanged` | `settings.js` + `preload.cjs` 同名能力，且多出 `patch` / 回滚 / Vault | `desktop-ahead` | desktop-pet 已有更完整的保存链路；P4 只补页头四态，不重写保存核心。 |
| Live2D 模型导入 | `models.mjs`、`preload.cjs` 的 `listModels/importModel/setActiveModel`、`settings.html` 模型区 | `apps/desktop/electron/models.mjs`、同名 preload 方法、`settings.html:123-141` 模型区与缩略图 | `desktop-ahead` | 两侧都有；desktop-pet 多出素材包与缩略图网格。 |
| Live2D 运行时 vendor | `renderer/vendor/` 4 个文件，共 791,294 字节 | `renderer/vendor/` 同样 4 个文件，文件名与体积一致 | `same` | 不需要移植。 |
| 内置模块开关 | `settings.modules` + `module-bubble/reminder/balance` 开关 | `settings.modules` + `moduleHost` + 设置页模块开关 | `desktop-ahead` | desktop-pet 已有模块宿主与 worker sandbox。 |
| 模块 worker 隔离 | `workerSandbox/workerRuntime/workerProtocol` 未跟踪新增 | 同名文件已存在 | `desktop-ahead` | desktop-pet 已吸收并继续演进。 |
| TTS provider | `packages/core/src/media/ttsProvider.ts` 未跟踪新增 + 测试 | 同名实现与测试已存在 | `desktop-ahead` | 不需要移植。 |
| 双宿主探针模块 | `renderer/petals/dyad-pet/core.mjs`、`index.mjs` | 未找到 `renderer/petals/` | `optional` | 这是 `dyad.pet` 探针模块，不参与 P4 与安装包；如要保留双宿主验证，可后续单独移植。 |
| 窗口参数 | `windowShell.ts` `resizable:true`、透明、无边框 | 同名文件当前也 `resizable:true` | `same` | 本轮 desktop-pet 要改成固定尺寸；这是产品选择，不反向要求框架。 |
| 拖动 / 尺寸恢复 | `main.mjs` 拖动与位置持久化 | `main.mjs` 已有拖动静止、吸附、抛掷、尺寸恢复 | `desktop-ahead` | desktop-pet 的拖动逻辑更完整；本轮只删除拖动结束恢复 `setResizable(true)` 并改启动恢复只取位置。 |
| 透明命中 | `renderer.mjs` 仍用 `fullFrameRect` | 同名逻辑 | `same` | 两侧都有透明区抢点击问题；修法可回移，但本轮只在 desktop-pet 落地。 |
| 位图 / GIF 比例 | `imageAdapter.paint()` 拉满画布 | 同名实现 | `same` | 两侧都会拉伸；contain 修法可回移。 |
| 视频比例 | 视频元素无 `object-fit` 约束 | 同名缺口 | `same` | 两侧都补 `object-fit: contain`。 |
| 打包入口 | 只有 `electron-builder --dir`，无 `scripts/package.mjs` | `scripts/package.mjs`、`check-package.mjs`、校验和、正式 / 调试双通道 | `desktop-ahead` | 安装包只在 desktop-pet 上做。 |
| 打包资源白名单 | `electron-builder.yml` 有托盘图标与 `assets/**` 修复，但仍只产 `dir` | 已有更完整的白名单、`*.mjs` 同级模块、排除项与图标 | `desktop-ahead` | 不把框架的旧配置反向覆盖。 |
| 安装包 | 无 | 无（本轮新增 NSIS） | `same-gap` | 框架 README 明确「不包含安装包」，本轮只补 desktop-pet。 |
| 契约门禁 | `check-module-boundaries.mjs` 未跟踪新增 | 同名脚本已存在并挂在 `verify` | `desktop-ahead` | 不需要移植。 |
| 素材授权 / 体积门禁 | 框架有 `assets*` 禁令与 PLACEHOLDER 排除 | desktop-pet 有 `check-assets-license` / `check-image-size` / `check-third-party` | `desktop-ahead` | 安装包继续沿用 desktop-pet 的更严门禁。 |

---

## 三、结论

### 1. 没有 `must` 项

框架工作区里已经完成的设置、模型导入、vendor、TTS、模块隔离、打包白名单，在 `desktop-pet` 都有对应实现，而且多数更完整。把它们整体搬过来会覆盖 desktop-pet 的 QQ、i18n、素材包、备份、记忆等新能力，属于反向破坏。

### 2. `optional` 只有一项

- `renderer/petals/dyad-pet/`：双宿主探针模块，不参与 P4 与安装包。
- 处理方式：记入 backlog；本轮不移植，避免把框架未通过的 p3 冒烟和探针依赖带进发布包。

### 3. 共享修法保持可回移

本轮会改到两侧同源的三个位置：

| 位置 | desktop-pet 改法 | 回移建议 |
| --- | --- | --- |
| `packages/core/src/render/imageAdapter.ts` | `paint()` 改 contain、居中、先清空 | 可直接回移；框架的 `imageAdapter` 结构相同 |
| `apps/desktop/electron/renderer/renderer.mjs` | 新增 `isOpaqueHit()`，2D canvas 读 alpha，WebGL 回退整帧 | 可直接回移；框架 `renderer.mjs` 的命中入口相同 |
| `apps/desktop/electron/renderer/styles.css` | 视频 `object-fit: contain` | 可直接回移 |
| `apps/desktop/src/windowShell.ts` | `resizable:false` | 不回移；框架是通用壳，固定尺寸属于产品选择 |
| `apps/desktop/electron/main.mjs` | 删除拖动结束 `setResizable(true)`、启动只恢复位置 | 不回移；与固定尺寸绑定 |
| `electron-builder.yml` | 增加 NSIS target | 不回移；框架本轮不产安装包 |

### 4. 框架工作区不直接修改

按本轮已确认：先盘点差异，再决定移植哪些。盘点结果没有 `must`，因此不改 `dsh-pet-framework` 仓库，也不清理它未提交的 42 个文件。那批改动属于框架自己的进行中工作，需要由它自己的提交节奏处理。

---

## 四、对 P4 的保护清单

P4 重组导航时，以下 desktop-pet 已完成能力必须保持可用：

- 设置搜索与计数、气泡实时预览、主题色板、模型 / 表情 / 贴纸选择、人格字数计数；
- 语音试听与参考音频、API Key 测试、余额查询；
- 记忆搜索 / 筛选 / 导出、聊天导出 / 清空、自动备份与恢复；
- 危险区确认、Vault 口令与密钥提示、i18n 中英对称、写死色值门禁；
- QQ 双路线设置与运行状态、素材包禁用与结构化错误、模块开关与诊断。

---

## 五、证据索引

- 框架设置页：`projects/dsh-pet-framework/apps/desktop/electron/renderer/settings.html`
- 框架窗口参数：`projects/dsh-pet-framework/apps/desktop/src/windowShell.ts:31-56`
- 框架位图绘制：`projects/dsh-pet-framework/packages/core/src/render/imageAdapter.ts:115-119`
- 框架命中判定：`projects/dsh-pet-framework/apps/desktop/electron/renderer/renderer.mjs:190-196`
- 框架打包：`projects/dsh-pet-framework/electron-builder.yml`、`package.json`
- desktop-pet 同名文件：`projects/desktop-pet/apps/desktop/src/windowShell.ts`、`packages/core/src/render/imageAdapter.ts`、`apps/desktop/electron/renderer/renderer.mjs`
- desktop-pet 打包：`projects/desktop-pet/scripts/package.mjs`、`scripts/check-package.mjs`、`electron-builder.yml`
- desktop-pet 已完成条目：`projects/desktop-pet/docs/SSOT.md`
