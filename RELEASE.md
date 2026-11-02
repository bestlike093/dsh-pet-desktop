# 发布流程

## 版本

当前基线：`2.0.0-dev.0`。开发期使用 `2.0.0-dev.N`，每次可交付变更递增 N；进入候选后改为 `2.0.0-rc.N`，正式版为 `2.0.0`。

版本号同时出现在：

- 根 `package.json`
- 各子包 `package.json`
- `createDesktopBridge(version)` 与诊断面板标题

## 发布前检查

```powershell
$env:PATH='D:\<工作区>\tools\node;D:\<工作区>\tools\npm-global;'+$env:PATH
D:\<工作区>\tools\npm-global\pnpm.cmd install
D:\<工作区>\tools\npm-global\pnpm.cmd -r run build
D:\<工作区>\tools\npm-global\pnpm.cmd -r run typecheck
D:\<工作区>\tools\node\node.exe scripts\verify.mjs
```

最后一条必须输出 `P6_GATE_OK`。门禁包含：

| 检查 | 阈值 |
| --- | --- |
| 依赖方向 | 只允许 `shared ← core / vault ← apps` |
| 运行时依赖 | 非 workspace 依赖为 0 |
| dist 合计 | ≤ 2 MiB |
| 单文件 | ≤ 256 KiB |
| 冒烟 | p0–p6 全部通过，失败项为 0 |

## 产物

当前阶段交付的是框架基线，产物为各包 `dist/`：

```
packages/shared/dist
packages/core/dist
packages/vault/dist
apps/desktop/dist
```

不包含 Electron 运行时、PIXI 资源与安装包。

## 分发方式（未定，当前阻塞内测）

`d23bc43` 移除了 Electron 打包链路，`apps/desktop` 现在是本地夹具，只有 `pnpm start` 一条路。内测者拿到东西的方式需要重新决定，三个选项：

| 方式 | 工作量 | 代价 |
| --- | --- | --- |
| 源码 zip + 说明 | 半天 | 对方要装 Node 与 pnpm，环境问题会占掉大量反馈 |
| 免安装 exe（重新接回打包） | 1–2 天 | 要把刚移除的链路接回来，等于撤回一个决定 |
| 让内测者拉仓库自己跑 | 0 | 只适合会开发的少数人，拿不到普通用户反馈 |

这个选择决定 11-01 能不能发。选定之前，包 1 的自检也只能覆盖源码路径。

## 内测发包节奏

内测不是一次发完，按包推进。每个对外包后面留 3–5 天反馈窗口，窗口内不改对外契约，否则正在测的包和代码库对不上，反馈无法归因。

| 包 | 内容 | 对外 | 时间 |
| --- | --- | --- | --- |
| 包 1 | 自检包：A1 五步走查 + B2 行为 | 否 | 10-31 |
| 包 2 | 能力层十二项 × 两形态，含 B2 待机与点击反馈 | 是 | 11-01 ~ 11-02 |
| 包 3 | 替身模块，或与包 2 合并（2D 后评估） | 是 | 11-07 ~ 11-08 |

包 1 不对外，是为了先把环境问题清掉。内测者的耐心是一次性的，不该消耗在装不上这类问题上。

包 2 的说明里必须写清已知问题，比如「点击判定为矩形，透明边缘也会响应」。不写，它会当成 bug 报回来，占掉一轮反馈配额。

## 回滚

- 回滚前先确认当前工作区已提交，再检出上一个可用 tag
- 代码回滚后重新执行 `pnpm -r run build`，不要复用旧 `dist`
- Vault 文件格式升级需要同时保留旧版本读取路径；当前只支持 `version: 1`

## 发布清单

- [ ] 版本号已统一更新
- [ ] `pnpm -r run build` 通过
- [ ] `pnpm -r run typecheck` 通过
- [ ] `scripts/verify.mjs` 输出 `P6_GATE_OK`
- [ ] `README.md` 的状态与边界描述与实际一致
- [ ] 新增模块已补权限说明
- [ ] 新增错误码已写入 `packages/shared/src/errors.ts`
- [ ] 没有把 Electron 或平台 API 引入 `packages/core`
- [ ] 对外包说明首行写清已知问题与当前能力边界
- [ ] 反馈窗口内没有改动对外契约
- [ ] 包 1 未对外发出
