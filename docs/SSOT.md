# 唯一事实源（SSoT）

> 基线：`b532246` + A2 / A3 视觉批（`pnpm verify` EXIT=0，`P6_GATE_OK`）
> 产出：2026-11-01，B 批次（阶段 0）
> 最近同步：2026-11-02（第 41 条补齐 + 11/22/27/28/8/39/40/42/43/44/19/21 逐条复核为 ✓）
> 用途：后续 C–H 批次只做本文件标 `△` / `✗` 的条目；标 `✓` 的不重复做，标 `⚠️` 的直接从清单移除。
>
> 口径：`✓` 已落地 / `△` 部分落地 / `✗` 未做 / `⚠️` 已过时。
> 证据一律是 `相对路径:行号`（相对 `projects/desktop-pet/`）。找不到实现证据时判 `△`/`✗` 并写明「未找到证据」，不凭印象。

---

## 一、门禁基线（0.2）

三条门禁均已接入 `pnpm verify`：i18n 与写死色值已挂 `--strict`，图片体积仍是 `--strict --warn-only`，跑稳后再去掉告警。

| 门禁 | 脚本 | 基线数字 | 收紧条件 |
| --- | --- | --- | --- |
| i18n 覆盖 | `scripts/check-i18n-coverage.mjs` | 已挂 `--strict`；缺失 key 0 / 中文残留 0 / 字典不对称 0 | 已收紧 |
| 写死色值 | `scripts/check-hex-colors.mjs` | token 定义 56 处；裸用 0；已挂 `--strict` | 已收紧 |
| 图片体积 | `scripts/check-image-size.mjs` | 86 张，合计 2861.9KB；超 512KB 0 张；`--strict --warn-only` | 跑稳后去掉 `--warn-only` |

单跑命令：`pnpm check:i18n` / `pnpm check:hex-colors` / `pnpm check:image-size`。

---

## 二、62 条验收意见核对（0.1）

统计（2026-11-02 复核）：8 / 11 / 18 / 19 / 20 / 21 / 22 / 23 / 24 / 25 / 26 / 27 / 28 / 29 / 36 / 37 / 38 / 39 / 40 / 41 / 42 / 43 / 44 / 45 / 46 / 47 / 48 / 50 已判 ✓（48 的穿透 UI 待补）；其余条目仍按 `b532246` 基线，未逐条复核。

总体判断：这一轮验收意见基本还没动。已落地的是加密仓库层与两处既有接线；17 条 `△` 多数是「旧实现沾到一点边」，不是「新需求做了一半」。

### 阶段 1 · 设置页快速改善（✓4 / △2 / ✗8）

| 序号 | 任务 | 结论 | 证据 | 缺口 |
| --- | --- | --- | --- | --- |
| 11 | 设置项搜索 | ✓ | `renderer/settings.html:20-29` 搜索框与命中计数；`renderer/settings.js:271-320` 过滤与高亮，`:2068` 输入即过滤、`:2100` 快捷键聚焦 | — |
| 22 | 气泡实时预览 | ✓ | `renderer/settings.html:296-300` `bubble-preview` 气球与贴纸容器；`renderer/settings.js:435/463` 滑杆、底图、字体、贴纸改动即时回写 | — |
| 23 | 主题色板缩略图 | ✓ | `theme.css:62-65` 定义 `--theme-preview-blue/pink/ink`；`settings.css:407-439` 用 `#theme-seg button::before` 画色点，`.active::before` 加外圈描边；`settings.html:112-114` 三个按钮 `data-theme` 与选择器一一对应 | — |
| 27 | 语音试听 + 文件选择器 | ✓ | `renderer/settings.html:928-938` 选择文件与试听按钮；`renderer/settings.js:1189-1215` `pickRefAudio()` + `speakVoice(text,'manual')`，失败写 `data-preview="failed"` | — |
| 28 | API Key 测试连接 | ✓ | `renderer/settings.html:837` 「测一下」；`renderer/settings.js:1218-1232` 调 `testLlm()`，成功显示 model + 耗时，失败显示 reason | — |
| 30 | 缩放 / 尺寸像素读数 | ✗ | `settings.js:106-108` 只显示倍数 | 无实际像素读数 |
| 31 | 背景渐变吃 token | △ | `settings.css:17` 已用 token；`chat.css:16` 仍写死 `#fffafc/#ffeef6` | 聊天窗底色未跟随主题 |
| 32 | 渐变第二端吃 token | △ | `chat.css:150`、`chat.css:277` 仍有 `#f59cc4` | 残留 2 处 |
| 33 | 开关轨道统一 token | ✗ | `settings.css:198` `#f2dae5`；`onboarding.css:212` `#e7dbe3` | 两窗各写各的，无共用 token |
| 10 | 深链直达接线 | ✗ | 机制在 `main.mjs:1797-1802`，但调用方 `main.mjs:2205-2209`、`1291-1301` 全不带参 | 托盘/右键无「设置→语音/备份」入口 |
| 9 | 同步设置入口 | ✗ | 托盘项 `main.mjs:2177-2204`，未配置时静默 return；设置页无同步区块 | 不能配目录；未配置时点了没反应 |
| 12 | 记住面板 + 图标 + 快捷键 | ✗ | `settings.js:1377` 只处理 hash 与事件 | 记住面板 / Esc / Ctrl+F 全缺 |
| 13 | section 恢复默认 | ✗ | `settings.js` 无 reset 逻辑 | 无分段重置与确认 |
| 14 | 未保存标记 | ✗ | `settings.js` 无脏值跟踪，change 即落盘 | 无高亮与离开提示（需先定语义） |

### 阶段 2 · 信息架构重组（✓7 / △2 / ✗5）

| 序号 | 任务 | 结论 | 证据 | 缺口 |
| --- | --- | --- | --- | --- |
| 1 | 九面板并为四组 | ✗ | `settings.html:21-29` 仍是 9 个平级 `button[data-panel]` | 无分组标题 |
| 2 | 通用面板拆两组 + 折叠 | ✗ | `settings.html:37-260` 七个 section 平铺 | 无分页/折叠 |
| 3 | 气泡设置合并 | ✗ | 气泡 `137-185` 与素材包 `187-253` 分离 | 未按内容→外观→底图→贴纸排 |
| 4 | 语音设置合流 | △ | `settings.js:1142-1144` 写入了 `#voice-service-note` | 无 builtin 状态块与深链 |
| 5 | 记忆入口定一处 | ✓ | `ability.js:12`、`ability.js:268-271` → `openSettingsPanel('memory')` | — |
| 6 | Key / 余额状态归位 | ✗ | Key 区 `settings.html:611-628` 无状态与查余额；余额在 `827` | 未归位 |
| 7 | 状态面板只读化 | ✗ | `settings.html:879-931` 仍含 preflight/diag/加密备份 | 备份未搬离 |
| 8 | 数据与备份独立组 | ✓ | `renderer/settings.html:1166-1173` 自动备份开关与保留天数；`renderer/settings.js:1809-1901` 读写 `backup:setAuto` 并回显状态 | — |
| 39 | 素材「随包 / 导入」分栏 | ✓ | `renderer/settings.js:2328-2432` 按 `source === 'builtin'` 分两组，底部汇总 `summaryBuiltin` | — |
| 40 | 素材包可禁用 | ✓ | `renderer/settings.js:2409` 列表内开关、`:2439-2450` `window.pet.setPackEnabled` | — |
| 41 | 导入失败给结构化原因 | ✓ | `packs.mjs` 的 `validateEntries` 收集全部问题（`PATH_UNSAFE` / `MODEL_FILE` / `FILE_TOO_LARGE` / `TOTAL_TOO_LARGE`），`packError` 带 `details`；`ipc/mutations.ts` 截断 20 条后回传；`settings.js` 逐条列出（最多 6 条 + 余数），`#packs-status` 用 `white-space: pre-line`；`packs.test.mjs` 新增 2 条断言 | — |
| 42 | 记忆搜索 / 筛选 / 导出 | ✓ | `renderer/settings.html:724` 导出按钮；`renderer/settings.js:729` 筛选判定、`:1582-1588` 搜索输入、`:1623` 导出按当前筛选 | — |
| 43 | 自动备份 + 恢复文件选择 | ✓ | `electron/main.mjs:1965` 每 6 小时 `maybeRunAutoBackup()`；`:2036-2047` 恢复弹系统文件选择框 | — |
| 44 | 聊天记录导出 / 清空 | ✓ | `renderer/settings.html:1250` 导出；`renderer/settings.js:2676-2681` 清空走 `confirmAction({strength:'danger'})` | — |

### 阶段 3 · 安全确认层（✓3 / △3 / ✗0）

| 序号 | 任务 | 结论 | 证据 | 缺口 |
| --- | --- | --- | --- | --- |
| 15 | confirmAction 助手 | △ | 散落 `window.confirm`：`settings.js:1003/1031/1056/1322` | 无统一助手与强度分级；记忆删除无确认 |
| 16 | 素材包删除确认 | △ | `settings.js:1322` 只显示 id | 缺包名与文件数 |
| 17 | 密钥轮换后果提示 | △ | `settings.html:912,917` 有口令提示 | 未说明「旧备份失效」 |
| 18 | 恢复倒计时 + 口令策略统一 | ✓ | `renderer/onboarding.js:168-230` 5 秒倒计时，按钮变「取消恢复」可反悔；口令阈值与提示统一在 `renderer/backup-policy.js`，`settings.js` / `onboarding.js` 都引用；`backup-policy.test.mjs` 3 条断言 | — |
| 19 | 清除 Key 确认 | ✓ | `renderer/settings.js:1780-1788` 先 `confirmAction`，文案写明停用范围与恢复方式 | — |
| 20 | 计费动作提示 | ✓ | 「测一下」「立即巡视一次」「生成今日反思」三个会真实调用模型的按钮旁均有「调用一次模型，消耗 token」提示（`common.tokenCost`，中英对称） | — |
| 21 | 危险区视觉分离 | ✓ | `renderer/settings.css:595-615` `.danger-zone / .danger-title / .danger-btn`，独立分隔线与危险色 | — |

### 阶段 4 · 视觉 / 文案一致性（✗9）

| 序号 | 任务 | 结论 | 证据 | 缺口 |
| --- | --- | --- | --- | --- |
| 34 | #fff 硬编码收 token | ✓ | renderer 根目录 css/html 无裸 `#fff`；`check-hex-colors --strict` 裸用 0；纯白只在 `theme.css:68 --white` 定义 | — |
| 35 | 语义色收 token | ✓ | `theme.css:69 --danger`、`:72-73 --disabled-opacity*`；7 处 `:disabled` 与 `.section.pending` 已引用；无图表视图，不预置 `--chart-*` | — |
| 36 | 禁用 select 改说明卡 | ✓ | `renderer/settings.html` 全页无 `disabled`（findstr 0 命中）；说明卡见 `:903`、`:995`、`:1003` 的 `.value-static` | — |
| 37 | 人称统一 | ✓ | `renderer/onboarding.html` 全文无「它」（findstr 0 命中） | — |
| 38 | i18n 补齐 + 门禁 | ✓ | `package.json:17` 已挂 `check-i18n-coverage.mjs --strict`；当前缺失 key 0 / 中文残留 0 / 字典不对称 0 | — |
| 24 | 立绘缩略图网格 | ✓ | `renderer/settings.html:106` 有 `#model-grid`；`renderer/settings.js:489-529` 渲染卡片与选中态 | — |
| 25 | 素材包缩略图 + 占用 | ✓ | `packs.mjs:359` 返回 `bytes`；`renderer/settings.js:1998-2012` 显示占用并渲染 `pack-thumb` | — |
| 26 | 表情 / 贴纸可视化选择器 | ✓ | `renderer/settings.html:259` 有 `#sticker-grid`；`renderer/settings.js:1867-1938` 缩略图墙 + 点击回写 | — |
| 29 | 人格字数计数 | ✓ | `renderer/settings.html:934`；`renderer/settings.js:790-798` 实时计数；`renderer/settings.css:631-646` 90% / 写满分档着色 | — |

### 阶段 5 · 打扰控制与桌面相处（△2 / ✗2）

| 序号 | 任务 | 结论 | 证据 | 缺口 |
| --- | --- | --- | --- | --- |
| 45 | 免打扰统管（声音 + 冒泡 + 状态栏） | ✓ | 判定唯一实现在 `packages/shared/src/settings/quiet.ts`（`presenceQuietModeAt`），主进程 `quiet-mode.ts` 只做再导出；`main.mjs` 的气泡/日报按 silent/urgentOnly/reduce 处理；`voice-service.mjs` 对 auto 朗读在时段内返回 `quiet-hours`；`presence.quiet.hideHud` 由 `renderer.mjs` 每 30 秒重算 HUD 显隐；语音页 `voice.quietHours` 作为额外子项保留 | — |
| 46 | 安静一小时 / 专注模式 | ✓ | `main.mjs` 的 `startQuiet`/`stopQuiet`：托盘提供 15/30/60 分钟，`quietTickTimer` 每 30 秒重建菜单刷新「还剩 N 分钟」，tooltip 同步；到点自动清零、重建菜单并提示「安静时间结束了」；「取消安静」立即恢复 | — |
| 47 | 窗口找回 | ✓ | `main.mjs:1664-1677` `dockPetToBottomRight` 接右键「把桌宠找回来」；启动钳制保留在 `:2340` 一带 | — |
| 48 | 吸附参数 / 穿透 / 开机自启 | ✓ | 设置页「通用」提供边缘吸附开关与 4–64 px 吸附距离（`window.edgeSnapDistance`），`main.mjs` 的 `applyEdgeSnap` 按该值判定；开机自启走托盘勾选，写系统登录项，未打包时提示「打包后可用」；穿透按既有裁定不设 UI | 穿透 UI 按裁定排除，不计缺口 |

### 阶段 6 · 工程规范与发布清洁（✓4 / △1）

| 序号 | 任务 | 结论 | 证据 | 缺口 |
| --- | --- | --- | --- | --- |
| 49 | 语言双轨统一 | △ | 已迁 `settings-patch` / `quiet-mode` / `window-bounds` / `state` / `error` / `memory` / `ipc/queries`（19 条只读通道）/ `ipc/mutations`（资产、备份、设置 7 条）/ `ipc/voice`（speak、pickRefAudio）/ `ipc/models`（3 条）/ `ipc/sync`（5 条）/ `ipc/memory`（export、delete、clear）/ `ipc/vault`（rotate、export、diagnose、import）/ `ipc/backup`（findLatest、setAuto）到 `apps/desktop/src/main/`；测试 1612 条绿；`main.mjs` 2665 行；`ipc/README` 含查询语义优先、白名单只增不改、互斥锁跟随主进程任务、ShellDeps 收口规则，70 个 channel 注册唯一、1 条内部探针不暴露渲染，契约 75 条 | 剩余 28 条写通道按域继续迁 `ipc/`；`vault:rotate` 已改为先落盘再提交内存，失败不再产生进程/磁盘分叉（`de43131`） |
| 50 | 素材压缩落地 | ✓ | `scripts/build-assets.mjs` 从 `assets-gen/source` 生成 512/256 版；`package.json:37` 接 `prebuild`；`package.json:17` 已挂 `check-image-size --strict --warn-only`；当前 86 张 2861.9KB、超限 0 | — |
| 51 | 发布包清理 | ✓ | 双通道 `package:dir` / `package:debug`；`resources/checksums-sha256.txt` 锁 `resources/app` 且 `check:package` 可复现；声明层剔除 lodash/gh-pages/qs/fs-extra/async；正式包 0 map、调试包 391 map；@pet 恰好 2 处且各自解析冒烟通过 | — |
| 52 | 模块沙箱 + sync 断言 + 三条门禁 | ✓ | 沙箱在 `packages/core/src/modules/moduleSandbox.ts`（`createSandboxContext`、`installRealmNetworkGuard`），宿主状态机与超时收口在 `moduleHost.ts`，`moduleHost.test.ts` / `moduleShapeGuard.test.ts` 覆盖崩溃与非法跳转；sync 由 `apps/desktop/electron/__tests__/sync.test.mjs` 8 条断言覆盖（白名单、冲突、脱敏、加密、错口令、无口令）；三条门禁已进 verify | — |
| 54 | AesGcmProvider 缓存修复 | ✓ | `vault/src/crypto/provider.ts:71-72,102-112` + `aesGcmKeyCache.test.ts` | — |

### 阶段 7 · 加密升级（△1）

| 序号 | 任务 | 结论 | 证据 | 缺口 |
| --- | --- | --- | --- | --- |
| 53 | rotate() 确认 + CS2 / Argon2id | △ | `vaultClient.ts:245-249`、`fileKeyRing.ts:447` + 测试 | Argon2id 未评估；CS2 只有常量 |

### 阶段 8 · 能力扩展（✓1 / △3 / ✗5）

| 序号 | 任务 | 结论 | 证据 | 缺口 |
| --- | --- | --- | --- | --- |
| 55 | 会遗忘的记忆（衰减） | ✗ | `memory.mjs:182` 裸 FIFO | 无权重衰减 |
| 56 | 多通道 + QQ 唤醒 / 历史 | △ | `channel.ts:50-52` 契约；`qqOfficialChannel.ts:76` 实现 | 无唤醒与历史 |
| 57 | 作息机制 | ✗ | `schedule/scheduler.ts:3-18` 是重试退避 | 无时段问候/降频 |
| 58a | 余额监控 · 数据面 | ✓ | `balance-ledger.mjs`、`balance-ledger-store.mjs`、`balance-monitor.mjs`；`main.mjs:451-580` 接线；`balanceSmoke.mjs` 真机自检 | — |
| 58b | 余额监控 · 告警面 | ✓ | `balance-alert.mjs` 判定；`acks[v1@date@threshold]` 独立落盘；轮询 tick 推气泡；「知道了」写 `confirmed`；同 segment UI/存储双去重；5 个测试文件 62 条绿 | 真机跨日重响、改阈值不重响、7 天 prune 待跑 |
| 59 | 双轨语音 | ✗ | `voice-service.mjs:7-11` 只有本地合成 | 无云端计费轨 |
| 60 | Safe 陪伴版分发 | ✗ | `electron-builder.yml:71-73` 单一产物 | 无两套版本 |
| 61 | BetterGI 游戏日常 | ✓ | `core/src/game/` 7 文件；`apps/desktop/electron/game-daily.mjs`（检测 / 排班 / dry-run）；设置页「游戏日常」卡片；4 条 IPC；7 条测试 | 真实执行器另开一期 |
| 62 | 远程拍板演练 + 结构化 report | ✗ | `main.mjs:1495-1523` 只有三个通道 | 无 dry-run 与 report 回填 |

**58 拆分（2026-11-02，b3 封版）**：58 拆成 58a 数据面与 58b 告警面，两个不变量分开验收，避免用数据面的绿替告警面背书。

- **58a 数据面（✓）**：`balance-ledger.json` 升 v1，保留最近 7 个本地日切片，写入时裁剪；每片含 `date` / `tz` / `fetchedAt` / `balance` / `threshold` / `acknowledgedAt` / `lastAlertedAt`。`modules['builtin.balance'].enabled` 打开后按 `settings.balance.intervalMinutes` 轮询，改阈值或间隔下一轮生效，启动按 settings 重建；query 返回 7 天 slices。真机验证：`tz=Asia/Shanghai` 与切片日期一致、杀进程重启后切片仍在且 ≤7、冷启动首 tick 落账、v0 `{date,opening,latest}` 迁移保留旧值、冷启动与手动触发并发后仍 1 片。验收：改配置不重启生效、重启恢复轮询、query 返回 7 天 slices。
- **58b 告警面（✓）**：segment 键 `v1@date@threshold`，版本在前、阈值快照进键，跨日重响、改阈值不重响。ack 落独立 key `acks[segment]={at,level}`，`level` 只取 `shown` / `confirmed`；`markAck(segment, level='shown')` 写盘与 slice 裁剪同批次，成功后更新内存；`hasAck` fail-open。轮询 tick 命中后推气泡，气泡点「知道了」写 `confirmed`，自然消失或被顶掉只算 `shown`；同 segment 气泡 UI 只入队一个，与 ack 存储去重两道闸。系统通知 tap 将来复用同一 `pet:balance:ack` 通道。真机待跑：跨日重响、改阈值不重响、7 天 prune。

---

## 三、Cyrene 本体功能基线（H 批次用）

宿主：`cyrene-agent` 1.3.4，`app.asar` 约 525MB / 19996 文件（含 node_modules），自带 Live2D、Agent 运行时、插件市场、技能体系。
证据来自 asar 目录表与用户数据目录文件名，**未解包、未读正文**。

### 完全空白且优先级高的三处

1. **技能体系**：宿主有扫描/注册/斜杠激活/快照安装（`main/skills/**` 17 文件、`D:\cyrene\skills\` 10 个技能），桌宠零实现。
2. **ASR 语音识别**：宿主有阿里/火山/minimax/mossland 四家 + 调度（`main/asr/**`），桌宠只有能力声明。
3. **插件市场与插件面板**：宿主有 `plugin-marketplace` + `plugin-host` 12 服务 + 8 个已装插件，桌宠有模块宿主但无市场契约。

### 「部分」但同样高优先级

- `shell` / `git` / `lsp` 工具链与权限沙箱（宿主 `orchestrator/tools` + `sandbox-exec`，桌宠无对应物）
- 记忆判官与压缩调度（桌宠 `packages/memory` 只有存储原语）
- 定时任务 cron（桌宠只有 `scheduler.ts` + 提醒模块）
- TTS 多引擎与缓存（桌宠只有单一 provider）
- 可见浏览器控制（桌宠 `browse/*` 只是 B 站抓取）

### 完整功能域（13 域 / 50 条）

| 功能域 | 具体能力 | 桌宠现状 | 优先级 |
| --- | --- | --- | --- |
| 对话与模型 | 多供应商双协议适配 | 已有 | 中 |
| 对话与模型 | 流式/思考过滤/中断/重试/超时 | 部分 | 高 |
| 对话与模型 | Agent 运行时（run/tool round/compaction/recovery） | 无 | 中 |
| 对话与模型 | 计划模式 / 任务笔记本 | 无 | 低 |
| 对话与模型 | 上下文与 token 预算 | 部分 | 中 |
| 对话与模型 | AG-UI 桥接 | 无 | 低 |
| 工具与执行 | 内置工具集（fs/patch/ast-grep/lsp/git/shell/web…） | 部分 | 高 |
| 工具与执行 | MCP 接入 | 部分 | 中 |
| 工具与执行 | 权限审批 + 沙箱 | 部分 | 高 |
| 语音 | TTS 多引擎 + 流式 + 缓存 | 部分 | 高 |
| 语音 | ASR 多引擎与调度 | 无 | 高 |
| 语音 | 实时通话 | 无 | 中 |
| 记忆 | 记忆主链路（判官/压缩/冲突/审计/调度） | 部分 | 高 |
| 记忆 | Wiki + 摘要分层记忆 | 无 | 中 |
| 记忆 | 实体图谱 | 无 | 中 |
| 记忆 | 关系/亲密度日志 | 无 | 中 |
| 记忆 | 社交上下文 | 无 | 低 |
| 记忆 | Obsidian 双向同步 | 无 | 中 |
| RAG | 文档索引/向量检索/重排 | 无 | 中 |
| RAG | 世界书注入 | 无 | 中 |
| 插件 | 插件运行时（manifest/IPC/存储） | 部分 | 高 |
| 插件 | 插件市场 + 面板 | 无 | 高 |
| 技能 | 扫描/注册/斜杠/快照 | 无 | 高 |
| 形象 | Live2D 立绘与动作 | 已有 | 中 |
| 形象 | 贴纸语义检索 | 部分 | 中 |
| 形象 | 状态表情图组 | 部分 | 低 |
| 形象 | 主题/字体/风格端口 | 部分 | 低 |
| 学习 | 试卷生成/答题/存卷 | 无 | 中 |
| 学习 | 进度抽取回写 | 无 | 低 |
| 学习 | 学习导师技能 | 无 | 低 |
| 日程 | 定时任务（cron/历史/工具过滤） | 部分 | 高 |
| 日程 | 主动消息策略 | 部分 | 中 |
| 日程 | 任务/会话池 | 无 | 低 |
| 浏览器 | 内嵌浏览器面板 | 部分 | 高 |
| 浏览器 | 截图与键鼠操作 | 部分 | 中 |
| 浏览器 | 游戏辅助脚本引擎 | 部分 | 中 |
| 内容 | 音乐（网易云 + mpv） | 无 | 中 |
| 内容 | 朋友圈/动态 | 无 | 低 |
| 内容 | 新闻源 | 无 | 低 |
| 内容 | 邮件 OAuth | 部分 | 低 |
| 内容 | IM 渠道（微信/QQ/飞书） | 部分 | 中 |
| 外壳 | 托盘/多窗/窗口记忆/自启 | 已有 | 低 |
| 外壳 | Toast 通知窗 | 部分 | 中 |
| 外壳 | 设置体系 | 部分 | 高 |
| 外壳 | 自动更新 | 无 | 中 |
| 外壳 | SQLite 存储与迁移 | 部分 | 中 |
| 外壳 | 密钥保管 | 部分 | 中 |
| 外壳 | 备份与导出 | 部分 | 中 |
| 外壳 | 字体/GPU 诊断 | 无 | 低 |
| 外壳 | CLI 入口 | 无 | 低 |

### ⚠️ 结构性发现：宿主目录对不上

`packages/core/src/host/capabilityEvidence.ts` 与 `asarApiCatalog.ts` 记录的是 **dsh 0.2.1-rc.3** 的 96 个 `SERVICE_API` key，与这次盘点的 **Cyrene 1.3.4**（`dist/main/main/**`）不是同一套服务模型。

含义：要做到「Cyrene 本体有的桌宠也有」，需要一层新的 host adapter 映射，现有 catalog 校验脚本不能直接复用。这条已列入第五节待裁定。

---

## 四、敏感字段基线（B7）

现状：`memory.bin`、`chat.bin`、`secrets.bin`、`vault-keys.json` 全部走 vault；vault 不可用时**拒绝写盘**，不退回明文。这部分比预期干净。

### 必须先迁（高敏感且明文）

| # | 位置 | 字段 | 影响面 |
| --- | --- | --- | --- |
| 1 | `settings.json` | `companion.persona.extraPrompt` | 用户手写人格补充，明文；`settings` 全量经 IPC 广播（`main.mjs:1233`） |
| 2 | `settings.json` | 顶层 `llmApiKey`（迁移失败时） | `main.mjs:556-558` 失败分支保持原样且只写 console；`safeStorage` 降级机器会长期留明文 |
| 3 | `sync/<node>/*.json` | `companion.persona.extraPrompt` 副本 | 同步白名单含 `companion` 整块（`sync.mjs:13-29`），`fileSyncTransport.ts:117-140` 直写 JSON |
| 4 | `sync/<node>/*.json` | `voice` 整块（`refAudioPath` / `localUrl` / `cloud.baseUrl`） | 暴露用户名与内网拓扑；可能被 `PET_SYNC_DIR` 指到共享盘 |

### 结构性风险

- `pet:settings:save` **无字段白名单**（`main.mjs:183-193`、`1223-1235`）：渲染侧送什么键就落什么键。
- `.petbackup` 的 `files[]` 是原始字节 base64，只有 `sealed` 段加密（`vaultBackup.ts:149-170`）。当前无害，因为只装密文；扩容前必须先改造。
- `chat.bin` 不在 `BACKUP_FILES`（`main.mjs:509`）：换机会丢聊天记录，属功能缺口。

### 可以不动

`state.json`、`daily-state.json`、`rps-state.json`、`balance-ledger.json`、`models/`、`packs/`、`notes/reflection/*.md`、`reports/*.json`、`vault-state.json`、`settings.json` 其余低敏偏好。理由见 B7 原文（`.scratch/b7.md`）。

---

## 五、待柒柒裁定

1. **第 14 条「未保存标记」**：现状是 change 即落盘的即时保存模型，没有「未保存」这个状态。要么改验收标准，要么先给设置页引入草稿态。
2. **第 38 条 i18n**：门禁已进 verify，但只是基线模式；是按「门禁存在即算」记 `△`，还是按「门禁必须失败」保持 `✗`。
3. **本体对齐的目标宿主**：现有 `asarApiCatalog` 指向 dsh 0.2.1-rc.3，盘点对象是 Cyrene 1.3.4。H 批次要对齐哪一个，需要先定。
4. **B7 迁移范围**：四类明文是否全迁，还是只做「同步白名单剔除 + 迁移失败告警 + settings 键白名单」这三处最小修复。

---

## 五点五、第三方验收意见修复（2026-11-02）

对象：`agent-desktop-pet-第三方验收意见-2026-11-02.txt` 的 9 项。

| 编号 | 项 | 状态 | 落地位置 |
| --- | --- | --- | --- |
| S-4 | 模块解压先 staging 再 rename，拒符号链接 | ✓ | `packages/core/src/modules/zipExtractor.ts` |
| S-6 | HTTP 响应体上限，超限报 `too-large` | ✓ | `packages/core/src/*/httpJson.ts` |
| S-7 | 清单权限元素必须属于 `ALL_PERMISSIONS` | ✓ | `packages/core/src/modules/petalManifest.ts` |
| C-1~C-3 | token 估算按真实文本长度、refund 允许负数、预算不虚高 | ✓ | `providers/*`、`fallbackChain.ts`、`tokenBucket.ts` |
| C-4~C-5 | 记忆摘要长度截断；无快照时 fail-closed | ✓ | `memoryStore.ts`、`host/dshBridge.ts`、`host/hostAdapter.ts` |
| S-1~S-3 | 回复鉴权：`sender` 随回复下发，`authorizeReply` 校验 channel 与来源，QQ 官方渠道仅主人 openid 可触发 | ✓ | `channels/*`、`decisionGateway.ts`、`main.mjs`（`OwnerPolicy` + `PermissionBroker` + `SessionModeGate`） |
| S-5 | 沙箱加固：上下文与 api 冻结、网络接口遮蔽、Worker 执行形态 | ✓（未接桌面壳） | `moduleSandbox.ts`、`moduleHost.ts`、`workerProtocol.ts`、`workerRuntime.ts`、`workerSandbox.ts` |

S-5 的边界：主 realm 形态仍不是进程隔离，遮蔽只挡顺手出网；Worker 加载器已实现并有单测，桌面壳当前只加载可信内置模块，未切换到 Worker。

---

## 五点六、推送通道（2026-11-02）

- 默认通道：`%TEMP%\cyrene-api-push-next.mjs`（ssh-origin），逐条叠加，禁手动 `git push` / `git add -A`。
- 2026-11-02 一次性豁免：合并远端历史 `987dd9c`，两树一致、files changed = 0；新 `origin/main` = `987dd9c1053732a65711c00670c1d2da34fac2fb`。豁免已用完，自第 48 条起重回脚本通道。
- `git push` 不接受 `--ff-only`（那是 `git merge` 的选项，会报 `unknown option 'ff-only'`）。ff 保护写法：`git merge-base --is-ancestor origin/main HEAD` 断言 + `git push --no-force`。已写入仓库根目录 `CONTRIBUTING.md`。
- **待人工验证（2026-11-02）**：托盘「安静一会儿」→ 倒计时刷新 → 到点自动恢复。当日已实启一次应用：vault 装配 `secure=true`、记忆与聊天历史加载 ok、模块 `bubble=ready / reminder=ready / balance=disabled`、Live2D 载入 260ms、无 error；托盘点击本身未做，需在桌面手动点一次。

---

## 六、附：分报告

原始稿留在工作区的 `.cyrene/docs/b-batch/` 下（不进项目目录，避免本机路径被脱敏门禁命中）：

- `.cyrene/docs/b-batch/b1.md`：62 条核对原文（含判定依据与最不确定的三条）
- `.cyrene/docs/b-batch/b2.md`：宿主盘点原文（含 12 条不确定项）
- `.cyrene/docs/b-batch/b7.md`：敏感字段原文（含逐条迁移建议）
