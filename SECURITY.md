# 安全边界

> 本文按当前实现写。与代码不一致的表述算缺陷，改代码或改文档，不要两边各说一套。

## 信任模型

| 对象 | 信任级别 | 说明 |
| --- | --- | --- |
| `packages/shared` / `core` / `vault` | 可信 | 随应用分发，代码审查覆盖 |
| `apps/desktop` | 可信薄壳 | 唯一接触 Electron 与文件系统的位置 |
| 第三方模块 | 不可信 | 只通过声明权限与沙箱端口获得能力 |
| 外部资产文件 | 不可信 | 进入渲染前做扩展名、魔数与路径校验 |
| 远端同步变更集 | 不可信 | 校验节点、时间戳与字段后才合并 |

## 模块权限

模块在清单里声明权限，宿主在启动前要求 `PermissionBroker` 已授予同名权限，否则直接失败并返回 `PERMISSION_DENIED`。

| 权限 | 暴露的接口 | 典型用途 |
| --- | --- | --- |
| `ui.render` | `api.ui.render(html)` | 气泡、面板 |
| `ui.panel` | `api.ui.panel.register(spec)` | 侧边栏面板 |
| `net.egress` | `api.net.fetch(url, init)` | 余额查询 |
| `fs.user-assets.read` | `api.fs.readAsset(path)` | 读取用户素材 |
| `memory.read` | `api.memory.read(key)` | 读取记忆 |
| `memory.write` | `api.memory.write(key, value)` | 写入记忆 |

权限判断在上下文构建时完成（`createSandboxContext`），运行期不会给未授权模块补接口。没有授予 `memory.write` 时，`api.memory.write` 这个属性本身不存在，模块无法通过类型断言绕过。端口由桌面壳注入，拿不到端口时返回 `NOT_SUPPORTED`。

模块超时由 `Scheduler` 控制，超时抛 `MODULE_TIMEOUT`，不会拖住其他模块。

## 桌面壳

窗口参数固定为（设置页、聊天窗、引导窗同样适用）：

```ts
{
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true
}
```

`preload` 只暴露固定方法，每个方法绑定单一 channel，不接受调用方传入的 channel 名。

IPC 通道以 `apps/desktop/src/ipc.ts` 的 `IPC_CHANNELS` 常量清单为唯一来源，当前 51 条（以 `node scripts/check-ipc-contract.mjs` 的输出为准）。`scripts/check-ipc-contract.mjs` 在 `pnpm verify` 里比对三处：清单本身、主进程 `ipcMain.handle` 注册、preload 暴露方法。任何一处多出或缺失都会让门禁红灯。

路由行为：白名单外抛 `PERMISSION_DENIED`，白名单内但未注册抛 `NOT_SUPPORTED`。宿主能力缺失时统一降级为 `NOT_SUPPORTED`，不把底层异常透传给模块或页面。

主进程向渲染侧回传的路径只给文件名或 `pet-media://` 地址。模型列表、打开目录、备份导出都不返回绝对路径，避免把本机目录结构暴露给页面。

## 资产校验

三层，互相不替代：

1. `AssetManager.verify`：路径解析到根内 → 扩展名白名单 → 单文件上限 → 魔数与扩展名一致。默认上限 64 MiB。
2. `inspectUpload`：扩展名 → 大小 → 声明 MIME → 魔数。`.moc` 这类没有稳定魔数的格式跳过魔数检查，只靠扩展名与声明 MIME 兜底。
3. `zipExtractor`：条目路径规范化后必须在目标根内，拒绝符号链接与禁止入库的扩展名，嵌套压缩包有层数与总量限制。

任何一项失败返回稳定错误码，不返回部分内容。

## 素材边界

开发期的占位图只用自制的几何色块。第三方立绘、Live2D 模型、音频都走用户素材层，不进仓库、不进发布产物。

打包断言已接入 `pnpm verify`：`check:package` 校验产物清单，`check:assets` 断言 `assets/` 只含运行时素材、源素材留在 `assets-source/`，`check:third-party` 校验第三方声明齐全。产物里不含素材目录与 `.map`。

## Vault

两套加密模型，别混着讲。

**日常落盘（key-wrap）**

- 主密钥是随机 AES-256 密钥，数据用 AES-256-GCM 封装
- 主密钥与 Ed25519 签名私钥只以「被 OS 后端包裹」的形式存进 `keys.json`；私钥明文不落盘
- 后端优先 `safeStorage`；`passphrase` 与 `memory` 只能显式注入，不得作为生产默认。`memory` 每次重启都会丢密钥，`secure=false`
- Vault 文件 AAD 绑定 `magic | version | suite | kdf | updatedAt`；文件头篡改、密文篡改、套件替换分别返回 `VAULT_TAMPERED` 或 `CRYPTO_SUITE_UNSUPPORTED`
- 未解锁时读写返回 `VAULT_LOCKED`，落盘走 `writeAtomic`

**换机备份（口令）**

- `.petbackup` 用 PBKDF2-SHA256 派生，600,000 次迭代、16 字节随机盐、口令至少 8 位（界面建议 12 位以上）
- AES-256-GCM 封装，AAD 为 `pet-vault-backup|1`
- 导入时单个条目上限 64 MiB、全部条目合计上限 256 MiB、最多 64 个条目；条目数在解密前就拒绝，单条体积在 base64 解码前拒绝
- 导入前先写回滚快照，导入后停写并重启；口令错误直接拒绝，不做任何部分导入
- 口令丢失即无法恢复，界面必须二次确认

**密钥环状态**

`FileKeyRing` 的诊断返回 `keyRingState`（`ok | rebuilt | quarantined`）与 `signerState`（`ok | rebuilt | unavailable`）。`rebuilt` 与 `quarantined` 都意味着旧密文可能已不可读：损坏的 `keys.json` 会改名保留为证据，绝不静默覆盖。这两种状态在启动时只提示一次，并指向备份恢复入口。

**密钥轮换**

设置页「加密备份」区提供手动轮换入口（`pet:vault:rotate`），只有用户点确认后才会执行，没有自动调度。

- 轮换生成新的 32 字节数据密钥，`keyId` 与 `epoch` 各 +1，随后 `persist()` 写盘
- 旧密钥继续留在 `keys.json` 里，所以旧密文仍按原 `keyId` 解开
- 记忆与聊天历史的 `open` 显式传 `allowLegacyEpoch: true`；`open` 默认仍要求 epoch 相等，严格模式留给测试与诊断
- 代价是 `keys.json` 每轮换一次多一把钥匙，长期频繁轮换会让文件缓慢增长；当前没有自动清理旧钥匙的策略

威胁范围明确不包含：已控制操作系统的攻击者、内存抓取、恶意键盘记录。当前实现保护的是静态文件，以及导出后的备份文件。

## 远程拍板（QQ webhook）

- webhook 只监听 `127.0.0.1`，请求体上限 64 KiB
- 必须配置 `QQ_BOT_PUBLIC_KEY`：没有公钥就无从验签，通道不启用，请求返回 503
- 每个请求都校验 `x-signature-timestamp + body` 的 Ed25519 签名；签名缺失或错误返回 401
- 未通过验签的请求不会进入命令解析，也不会触发任何 `allow | deny | answer` 决定
- `appId / clientSecret / publicKey` 只从进程环境变量读取（`QQ_BOT_APP_ID` / `QQ_BOT_SECRET` / `QQ_BOT_PUBLIC_KEY`），不写入 `settings.json`、不进入渲染进程、不进入同步包与备份。QQ 凭据没有独立的 Vault 条目；不落盘本身就是它的存储策略，换机时需要重新配置。

## 同步

同步层的设计已经实现：每条记录带节点名与 HLC，时钟偏差超过 `maxSkewMs`（默认 5 分钟）整批拒绝，同 HLC 同值视为重放并幂等跳过，冲突保留双方时间戳。

桌面壳通过文件传输层把变更集写到 `userData/sync`（可用 `PET_SYNC_DIR` 指向共享目录），托盘里的「导出同步包 / 应用对端变更」是手动入口。仍然不连接任何远端端点，也没有后台自动调度；单包上限 512 KiB、单次最多读 200 个待处理包，节点名只允许字母、数字、点、下划线与短横线。

只同步跨机器有意义的偏好（昵称、语言、气泡、语音、陪伴、主题等）；窗口位置、尺寸档位、模块开关、本地模型路径不进入同步包。

## 已知限制

- 主 realm 执行的模块：沙箱上下文、config、`granted` 与 `api` 均已冻结，bootstrap 期间还会按 `net.egress` 遮蔽 `fetch` / `XMLHttpRequest` / `WebSocket` / `EventSource`。这挡住的是「顺手就出网」，不等于隔离——模块若在遮蔽前保存了引用，仍可能绕过。
- 需要执行完全不可信代码时，用 `createWorkerModuleLoader` 把模块放进 Worker：模块侧不持有宿主端口、DOM 与 Node 全局，能力只能经 `onApiCall` 回主线程代理，`terminate` 可整线程回收。该加载器已实现并有单测，桌面壳当前仍以主 realm 加载可信的内置模块，尚未接 Worker。
- 桌面壳的聊天、余额、语音是直接写在 `main.mjs` 里的 handler，不走模块沙箱。它们的能力边界由 IPC 白名单与各自的输入校验保证，不享受模块权限模型。
- 素材合规门禁与打包断言尚未接入，见上文「素材边界」。
