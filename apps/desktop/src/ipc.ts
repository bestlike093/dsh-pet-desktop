import { ErrorCode, PetError } from '@pet/shared'

/** 主进程↔渲染进程唯一允许的通道清单。新增能力必须同时改这里和 preload。 */
export const IPC_CHANNELS = [
  'pet:ask',
  'pet:approve',
  'pet:reportTask',
  'pet:settings:get',
  'pet:settings:save',
  'pet:settings:open',
  'pet:settings:close',
  'pet:qq:test',
  // QQ 运行状态：连接态、待发队列与 webhook 监听结果，只读。
  'pet:qq:status',
  'pet:window:setClickThrough',
  'pet:window:setAlwaysOnTop',
  'pet:window:move',
  'pet:window:applySize',
  'pet:window:getSize',
  'pet:window:dragStart',
  'pet:window:dragEnd',
  'pet:render:report',
  'pet:render:info',
  'pet:diagnostics:collect',
  'pet:models:list',
  'pet:models:active',
  'pet:models:import',
  'pet:models:setActive',
  'pet:models:openFolder',
  'pet:balance:query',
  // 余额告警确认：气泡上的「知道了」只写 ack，不改账本。
  'pet:balance:ack',
  'pet:menu:context',
  'pet:vault:diagnose',
  'pet:vault:export',
  'pet:vault:import',
  'pet:vault:rotate',
  'pet:backup:getConfig',
  'pet:backup:chooseDir',
  'pet:backup:setKeep',
  'pet:backup:run',
  // 自动备份：开关与间隔；口令由主进程用系统密钥加密保存。
  'pet:backup:setAuto',
  'pet:backup:findLatest',
  // 备份锁探针：只给主进程诊断与测试读锁状态，不暴露渲染。
  'pet:backup:probe',
  'pet:secrets:set',
  'pet:secrets:masked',
  'pet:secrets:clear',
  'pet:voice:speak',
  'pet:voice:status',
  'pet:chat:send',
  'pet:chat:history',
  'pet:chat:status',
  'pet:chat:clear',
  'pet:chat:export',
  'pet:chat:open',
  'pet:chat:close',
  'pet:memory:stats',
  'pet:memory:list',
  'pet:memory:delete',
  'pet:memory:export',
  'pet:memory:clear',
  // 启动前体检：模型 / 密钥 / 语音配置 / 磁盘 / Vault，一次汇总。
  'pet:preflight',
  // 每日巡视与反思：手动触发一次日报 / 生成三行反思。
  'pet:daily:run',
  'pet:daily:last',
  'pet:reflection:run',
  // 主动台词：被点一下 / 设置页试一句。
  'pet:presence:speak',
  // 能力中心：独立窗口入口；猜拳战绩只留内存，重启即清。
  'pet:ability:open',
  'pet:game:rps',
  // 游戏日常：检测 + 排班读写 + dry-run 预览；真实执行器另开一期。
  'pet:game:detect',
  'pet:game:schedule:get',
  'pet:game:schedule:save',
  'pet:game:dry-run',
  // 随包素材清单（表情 / 立绘），只回相对路径与 pet-media 地址。
  'pet:assets:list',
  // 素材包：用户导入的字体 / 图标 / 气泡 / 表情，存 userData/packs。
  'pet:packs:list',
  'pet:packs:import',
  'pet:packs:remove',
  'pet:packs:setEnabled',
  'pet:persona:preview',
  // 桌面状态条的系统指标：只读快照，主进程按固定间隔采样后推送。
  'pet:system:stats',
  // 心情快照：按当前时间与会话时长算，只回标签与等级。
  'pet:presence:mood',
  // 参考音频：只弹系统选择框挑本机音频，回绝对路径；不读文件内容。
  'pet:voice:pickRefAudio',
  // 连接自检：用已存的 Key 发一次最小请求，只回状态与耗时，不回密钥。
  'pet:llm:test',
  // 设置同步：导出快照 / 应用对端变更，只在本机同步目录里搬运。
  'pet:sync:run',
  // 同步目录查询与切换：不动云端数据，只改本机偏好。
  'pet:sync:info',
  'pet:sync:chooseDir',
  // 同步口令：只用于给同步包里的敏感字段加密，明文不落盘、不进包。
  'pet:sync:setPassphrase',
  'pet:sync:clearPassphrase',
  'pet:sync:passphraseStatus'
] as const

export type IpcChannel = (typeof IPC_CHANNELS)[number]

const ALLOWED = new Set<string>(IPC_CHANNELS)

export function isAllowedChannel(channel: string): channel is IpcChannel {
  return ALLOWED.has(channel)
}

/** 白名单外一律 PERMISSION_DENIED，不区分「拼错」和「越权」。 */
export function assertChannel(channel: string): asserts channel is IpcChannel {
  if (!ALLOWED.has(channel)) {
    throw new PetError(ErrorCode.PERMISSION_DENIED, `IPC 通道未授权：${channel}`, {
      details: { channel }
    })
  }
}

export interface IpcRequest {
  readonly channel: string
  readonly payload?: unknown
}

export type IpcHandler = (payload: unknown) => Promise<unknown>

/** 通道路由：只接受已注册 + 白名单内的调用，其余给稳定错误码。 */
export class IpcRouter {
  private readonly handlers = new Map<IpcChannel, IpcHandler>()

  handle(channel: IpcChannel, handler: IpcHandler): () => void {
    this.handlers.set(channel, handler)
    return () => {
      if (this.handlers.get(channel) === handler) this.handlers.delete(channel)
    }
  }

  async invoke(request: IpcRequest): Promise<unknown> {
    assertChannel(request.channel)
    const handler = this.handlers.get(request.channel)
    if (handler === undefined) {
      throw new PetError(ErrorCode.NOT_SUPPORTED, `通道没有处理器：${request.channel}`)
    }
    return handler(request.payload)
  }

  channels(): readonly IpcChannel[] {
    return [...this.handlers.keys()]
  }
}
