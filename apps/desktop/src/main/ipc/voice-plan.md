# voice 域搬迁前的五个裁定

动手前先把现有行为钉死，搬迁只挪注册，不改语义。以下结论均来自当前代码，不是设计愿望。

## 现状事实

- `pet:voice:speak` 在 `main.mjs:865`：读 `settings.voice`，用闭包里的 `lastAutoSpeakAt`（`main.mjs:863`）做节流，`planSpeak` 通过后**先推进节流时间**（`main.mjs:874`），再合成，返回 `{ ok, format, audio }` 或 `{ ok:false, reason, message }`。
- `pet:voice:status` 在 `queries.ts:107`：10 秒缓存，key 为 `endpoint|refAudioPath`，只探回环地址。
- 主窗口 `close` 只 `hide()`，不销毁 renderer（`main.mjs:2565-2573`）；真正退出走 `before-quit`（`main.mjs:2660`），只 flush 记忆与聊天历史。
- 托盘静音写 `settings.voice.enabled`（`main.mjs:2061` 注释），与设置页同一字段。

## 五问

### 1. 窗口关时，正在播的音频怎么办？

**播放跟随发起窗口的 renderer，不跟随主进程。**

`voice:speak` 只负责取回音频数据，播放器在请求方 renderer 手里。主窗口关闭是 `hide()`，renderer 存活，已拿到的音频继续播完；设置窗/聊天窗被销毁时，只有它们自己的播放器消失，不影响主窗口。真正退出时进程结束，音频自然停，不做「退出前等播完」。

迁移不引入主进程播放器，也不在 `close` 时主动发 stop。这样语义最简单，也不会出现「窗口藏了声音还在后台响」的新问题——声音本来就属于那个还活着的 renderer。

### 2. 节流状态的唯一写者是谁？

**主进程 voice 模块的模块级变量，唯一写者。**

现状 `lastAutoSpeakAt` 只写在 `main.mjs:874`，所有窗口共享同一个闭包实例；`planSpeak` 只读入参、返回 `autoSpeakAt`，不写任何状态。

搬迁后由 `voice.ts` 的 `let lastAutoSpeakAt = 0` 持有，`registerVoiceChannels(deps)` 只执行一次。不放进 settings：节流是进程内瞬时状态，落盘只会带来无意义的写盘和重启后的错误残留。

**只在真正开始合成时推进**；被 `busy` 或其它前置条件拒掉时不推进。manual 不推进，保证下一句自动台词不被手动点击挡掉。

### 3. 错误走 reason 还是抛？

**统一 `{ ok: false, reason }`，handler 不向 renderer 抛异常。**

现有 reason 集合保持不变：

| reason | 含义 |
| --- | --- |
| `empty` | 文本为空 |
| `silent` | 总开关/免打扰/只在小喇叭时 |
| `cloud-not-ready` | 云端还没接 |
| `no-ref-audio` | 没选参考音频 |
| `no-endpoint` | 没填本地地址 |
| `rate-limited` | 自动开口间隔未到 |
| `tts-failed` | 合成失败，附 `message` |
| `canceled` | 参考音频选择取消 |

并发互斥新增 `busy`。合成异常只影响这一次出声，渲染侧静默跳过，不影响气泡出字。

`voice:status` 的 `state` 与对外语义分开列，避免保护性拒绝被当成「没配置」：

| state | 触发 | 对外状态 |
| --- | --- | --- |
| `ready` | 探测通过 | 可用 |
| `disabled` | 能力整体关闭（`provider === 'off'`） | 主动关闭，**不是未配置** |
| `offline` | 探测超时/拒绝 | 服务没起来，可重试 |
| `no-endpoint` | 没填本地地址 | 未配置 |
| `no-ref-audio` | 没选参考音频 | 配置未完成 |
| `not-loopback` | 地址不是回环，或 URL 无法解析，拒绝探测 | 保护性拒绝，**不是未配置** |
| `cloud-unconfigured` | 云端没填地址 | 未配置 |
| `cloud-unverified` | 云端填了地址但未验证 | 待验证 |

`not-loopback` 必须单独给文案：用户填了地址，只是这个地址不允许发台词出去。把它和 `no-endpoint` 合并，回环保护就会被静默吞掉。

判定按决策树，不写成线性 if 顺序：

0. `voice.provider === 'off'` → `disabled`，不做 URL 判定、不探测
1. `localUrl` 去空后为空 → `no-endpoint`
2. 非空但 URL 无法解析、或 host 不在 `127.0.0.1` / `::1` / `localhost` → `not-loopback`
3. 回环地址但参考音频为空 → `no-ref-audio`
4. 回环且参考音频齐全 → 探测；通过 `ready`，失败 `offline`

第 0 层是能力开关，第 1 层是没配，第 2 层是配了但不敢信。三者不能压成两层：把 `disabled` 混进 `no-endpoint` 会让用户以为「填个地址就能开」，把 `not-loopback` 混进 `disabled` 会把保护性拒绝伪装成主动关闭。

合并的后果不是「措辞不精确」，而是把用户引到错的方向：

| 合并方式 | 用户看到 | 实际后果 |
| --- | --- | --- |
| `disabled` → `no-endpoint` | 没填地址 | 能力关着，用户被哄去填一个填了也不会生效的地址 |
| `not-loopback` → `no-endpoint` | 没填地址 | 地址明明填了，用户被说成没配，会反复重填、越改越乱 |
| `disabled` → `offline` | 服务没起来 | 用户被引导去重启服务、查端口，实际只是开关关着 |
| `not-loopback` → `offline` | 服务没起来 | 用户被引导去修一个不该连的服务，保护性拒绝被藏掉 |

所以「不许合并」是硬约束，不是措辞建议。reason 码与文案映射也只允许存在一份：`renderer/reason-text.js`。voice 与 chat 各自给码，文案都从那里取，禁止再写第二张表。

第 1 步必须压在第 2 步前面：空地址连 host 都没有，先判回环会把「未配置」伪装成「被拒」。端口非法同理，URL 都解析不出来，按不可确认回环处理。

### 4. 多窗口 speak 是丢、排，还是混？

**现状是「混」：共享 handler、无锁，并发请求各自合成、各自播放。搬迁时改成「丢」。**

- 单飞锁 `speakInFlight`，忙时直接 `{ ok:false, reason:'busy' }`；
- manual 也丢，不排队，用户可再点一次；
- 不排队的原因：语音是短句，排队会让声音滞后于气泡，听起来像对不上口型；重复合成还白耗本地 GPU。

这条与备份的互斥规则同源：锁跟随主进程任务，第二次并发直接拒，不产第二份结果。

**busy 必须给 UI 反馈，禁止吞。** 渲染侧收到 `{ ok:false, reason:'busy' }` 时要提示「上一次还在生成」或临时禁用按钮，不能让点击看起来没反应。归聊天域 renderer 验收；搬迁 voice 时一并检查这条，不留在主进程自测里。

### 6. 观察：voice 没有自有可变状态

除了 `lastAutoSpeakAt` 这个进程内节流时间，voice 域没有自己的可变状态。`voice:status` 的 10 秒缓存可能是死代码：设置页如果已经不再每 2 秒轮询，这个缓存就没有存在意义。等聊天、记忆、voice 三域搬完，回头看设置页的实际调用频率，再决定删缓存还是保留。

### 5. 音频焦点读不读 settings 同一份？

**读同一份，没有第二份 voice 状态。**

`voice:speak` 每次调用读 `settings.voice`（`main.mjs:866`），`voice:status` 读 `deps.getSettings().voice`（`queries.ts:108`），托盘静音写 `settings.voice.enabled`，设置页 `save` 写同一对象。

设置域二次验收结论：`settings:save` 的落盘值经 `sanitizeSettingsPatch` 过滤，`voice` 在 `settingsTopKeys` 内会被保留；广播 payload 与落盘形态是同一引用；`settings:get` 返回的也是同一份。因此 voice 读到的就是刚存下的值，不需要额外同步通道。

## 两种锁形态，别互抄

备份锁和 voice 软持有不是一套东西，迁移时按各自的表来：

| | 备份锁 | voice 软持有 |
| --- | --- | --- |
| 生命周期 | 单次备份任务，短事务 | 跟窗口/播放生命周期 |
| 释放 | `finally` 唯一路径，任务结束即放 | 窗口 `hide` 不释放；renderer 销毁或真退出才结束 |
| 并发策略 | 第二次 invoke 直接回 `BusyResult` | 单飞，忙时回 `busy`；manual 也不排队 |
| 失败 | 回 `failed`，锁照常释放 | 回 `tts-failed`，锁照常释放 |
| 观测 | 内部 probe（仅非 production） | 不引 probe，用播放状态与窗口生命周期判断 |

备份那边抄 `finally` 模板没问题；voice 这边如果照抄「任务结束就释放」，会把「窗口隐藏后声音还在播」误判成泄漏，或者反过来在 hide 时强行停声。两种语义分开写，省得下一个人靠猜。

聊天与记忆接下来按 voice 这套软持有模板走，不按备份锁模板：流式推送与批式写回的 main→renderer 通知归 queries 侧，订阅清理挂窗口销毁。备份锁只适用于短事务写盘。

搬聊天时把 `__voiceHeldWindows` 升成「活跃订阅集合」：delta 订阅清理必须幂等，窗口重建时先按 sender 清旧监听再挂新监听，别留指向已销毁 renderer 的死回调。

## chat 开刀三个照抄点

聊天与记忆按 voice 的软持有模板走，不按备份锁模板。开刀前把这三处钉死：

1. **软持有按 sender + conv 双键**：`Map<sender, Map<convId, Set<dispose>>>`，同一窗口的 A/B 两个会话各挂各的。`dispose(sender, convId)` 只关一个流，`dispose(sender)` 才是窗口销毁；验收断言「同 sender 开两 conv，关一留一，再销毁窗口清空」。
2. **活跃订阅集合**：`SubscriptionRegistry` 挂在 queries 侧，已经支持 conv 维度；delta 清理幂等；窗口重建先 `dispose(sender)`，`dispose` 对不存在的 sender 与 conv 都是 no-op，所以可以无条件调，再挂新监听。
3. **状态与通知分两层**：`chat:status` 的同步短路只判 provider、上下文、缓存 TTL 三件本地事；远端可达性走独立 stale 分支，返回允许过期的状态并后台探活。映射层用 `chat.state.stale`，不复用 `voice.offline`。main→renderer 的流式通知归 queries，订阅集合只负责释放，不承载业务状态。

遥测口径也定死：`unmappedCount` 进程级单调，只增不减；`resetUnmapped()` 只给测试与诊断入口调用，生产路径不得重置。用例共享同一实例时必须先归零，避免互相污染成偶发红。

## 迁移落点

- `pet:voice:speak` → `ipc/mutations.ts`（有副作用：发起合成、推进节流）
- `pet:voice:pickRefAudio` → `ipc/mutations.ts`（dialog）
- `pet:voice:status` → 留在 `ipc/queries.ts`（带缓存但语义是查询）
- `VoiceDeps`：`getSettings`、`createLocalTtsProvider`、`dialog`、`getDialogParent`、`log`
- 新测试 `voice.test.ts`：假 provider，覆盖各 reason 分支、`busy` 不推进节流、`tts-failed` 不抛、manual 不影响自动节流
- 不改 preload 形态，不加新 channel
