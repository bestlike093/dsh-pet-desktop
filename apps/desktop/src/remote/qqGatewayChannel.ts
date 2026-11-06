// QQ 官方机器人网关通道（WebSocket 被动回复）。
//
// 与 QqOfficialChannel（webhook）互斥：同一时间只应该有一条 QQ 连接。
// 2025-04-21 后官方不再支持主动推送，所有消息都必须带入站 msg_id；
// 没有可用入站消息时，envelope 进入该会话的待发队列，等主人下次发消息再补发。

import { ErrorCode, PetError } from '@pet/shared'
import type {
  ChannelCapabilities,
  ChannelSendResult,
  DecisionAction,
  DecisionEnvelope,
  DecisionReply,
  DiagResult,
  IChannelAdapter
} from '@pet/shared'
import type { WebSocketClient } from './websocket-client.js'
import { QqBotApiClient } from './qqbot-api-client.js'
import type {
  QqBotImagePayload,
  QqBotSendOptions,
  QqBotSendTarget
} from './qqbot-api-client.js'
import { QqBotWsClient } from './qqbot-ws-client.js'
import type { QqBotEventType } from './qqbot-ws-client.js'

export interface QqGatewayApi {
  getAccessToken: () => Promise<string>
  getGatewayUrl: () => Promise<string>
  sendText: (
    target: QqBotSendTarget,
    content: string,
    options: QqBotSendOptions
  ) => Promise<void>
  /** 可选：发图能力。测试桩不实现时，replyImage 直接回 false。 */
  sendImage?: (
    target: QqBotSendTarget,
    image: QqBotImagePayload,
    options: QqBotSendOptions
  ) => Promise<void>
}

/** 一条入站消息的发送者信息；观察模式靠它把 openid 交给宿主。 */
export interface QqGatewayInbound {
  readonly chatType: 'private' | 'group'
  /** 投递地址：C2C 为用户 openid，群为 group_openid */
  readonly openId: string
  readonly senderOpenId: string
  /**
   * 可选原文：只有需要判断「这句话是不是在叫我」时才带。
   * 只存在内存里，不落盘、不写日志；图片消息为空串。
   */
  readonly content?: string
  readonly msgId?: string
  /** 群里的 @ 消息：平台只会在明确叫到机器人时推这个事件。 */
  readonly mentioned?: boolean
  /** 发送者是否在主人名单里；宿主据此区分主人的私聊和群里的任何人。 */
  readonly isOwner?: boolean
}

/** QQ 消息里的一张图片；URL 有效期很短，宿主拿到后要立刻下载。 */
export interface QqGatewayImage {
  readonly url: string
  readonly contentType: string
  readonly filename: string
  readonly size: number
}

/** 主人发来的一条普通消息；宿主用它走聊天回复，不参与拍板解析。 */
export interface QqGatewayMessage extends QqGatewayInbound {
  readonly content: string
  readonly msgId: string
  readonly images: readonly QqGatewayImage[]
}

/** 只留在内存里的近期消息，用来学一群人的说话方式；不落盘、不外传。 */
export interface QqObservedMessage {
  readonly speaker: string
  readonly text: string
  readonly at: number
  /** 这条是否明确 @ 了机器人（平台只把这类群消息推成 GROUP_AT_MESSAGE_CREATE）。 */
  readonly mentioned?: boolean
  /** 图片 / 表情包数量，只用来估计表情包使用率。 */
  readonly imageCount?: number
}

/**
 * 群生命周期事件：机器人被拉进群、被移出群。
 *
 * 消息突然收不到时，靠这一条区分「平台没推」和「人已经不在群里」。
 * 只用于诊断，不参与权限判断。
 */
export interface QqGroupLifecycle {
  readonly type: 'GROUP_ADD_ROBOT' | 'GROUP_DEL_ROBOT'
  readonly groupOpenId: string
  /** 拉人 / 踢人的群成员；平台不提供时为空串。 */
  readonly operatorOpenId: string
  readonly at: number
}

export interface QqGatewayChannelOptions {
  readonly appId: string
  readonly clientSecret: string
  /** 允许拍板的主人 openid；空集合时任何消息都不会变成 DecisionReply。 */
  readonly ownerOpenIds?: readonly string[]
  /** 可选投递目标；空串/未设置时回复最近一次入站会话。 */
  readonly targetOpenId?: string
  readonly api?: QqGatewayApi
  readonly gatewayUrl?: string
  readonly websocketFactory?: (url: string) => WebSocketClient
  readonly maxBackoffMs?: number
  readonly now?: () => number
  readonly onLog?: (message: string) => void
  /** 连接层的最后一次错误，交给宿主展示；重连成功后会由 onReadyChange 清掉。 */
  readonly onError?: (error: Error) => void
  /**
   * 每条入站消息都会回调一次，且不受主人名单限制。
   * 观察模式靠它把发送者 openid 交回宿主，让用户在设置页一键绑定。
   */
  readonly onInbound?: (info: QqGatewayInbound) => void
  /**
   * 主人发来的普通文本。与 onInbound 分开：onInbound 只负责观察与绑定，
   * onMessage 才允许宿主生成回复，避免把任何陌生人都接进聊天链路。
   */
  readonly onMessage?: (info: QqGatewayMessage) => void
  /** 机器人进群 / 退群时回调一次，用来把「突然收不到群消息」的原因留进日志。 */
  readonly onSystemEvent?: (event: QqGroupLifecycle) => void
}

interface SessionState {
  readonly key: string
  readonly chatType: 'private' | 'group'
  /** 投递地址：C2C 为用户 openid，群为 group_openid */
  readonly openId: string
  readonly senderOpenId: string
  lastMsgId: string
  lastAt: number
  replyCount: number
}

const PRIVATE_WINDOW_MS = 60 * 60_000
const GROUP_WINDOW_MS = 5 * 60_000
const PRIVATE_MAX_REPLIES = 4
const GROUP_MAX_REPLIES = 5

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * 群 @ 的原文会带 <@!...> 标记；剥掉之后模型才看到干净的正文。
 * 机器人 openid 并不总是纯数字（新版是字符串 ID），所以这里不能只匹配 \d。
 */
function stripMentions(value: string): string {
  return value
    .replace(/<@!?[^>\s]+>/g, ' ')
    .replace(/[ \t\u3000]+/g, ' ')
    .trim()
}

function senderOpenId(data: Record<string, unknown>): string {
  const author = isRecord(data['author']) ? data['author'] : {}
  for (const key of ['user_openid', 'member_openid', 'openid']) {
    const value = textOf(author[key])
    if (value !== '') return value
  }
  return ''
}

/** 从 attachments 里挑出图片；只收 https 地址，其余一律忽略。 */
function imagesOf(data: Record<string, unknown>): QqGatewayImage[] {
  const raw = data['attachments']
  if (!Array.isArray(raw)) return []

  const images: QqGatewayImage[] = []
  for (const item of raw) {
    if (!isRecord(item)) continue
    const contentType = textOf(item['content_type']).toLowerCase()
    if (!contentType.startsWith('image/')) continue
    const url = textOf(item['url'])
    if (!url.startsWith('https://')) continue
    const size = Number(item['size'] ?? 0)
    images.push({
      url,
      contentType,
      filename: textOf(item['filename']),
      size: Number.isFinite(size) ? size : 0
    })
    if (images.length >= 4) break
  }
  return images
}

function formatEnvelope(envelope: DecisionEnvelope, now: number): string {
  const minutes = Math.max(1, Math.round((envelope.expiresAt - now) / 60_000))
  return [
    '【待拍板】',
    envelope.summary.slice(0, 200),
    `允许：allow ${envelope.id}`,
    `拒绝：deny ${envelope.id}`,
    `${minutes} 分钟内有效`
  ].join('\n')
}

export class QqGatewayChannel implements IChannelAdapter {
  readonly id = 'qq'

  private readonly owners: ReadonlySet<string>
  private readonly api: QqGatewayApi
  private readonly now: () => number
  private readonly log: (message: string) => void
  private readonly handlers = new Set<(reply: DecisionReply) => void>()
  private readonly readyHandlers = new Set<(ready: boolean) => void>()
  private readonly sessions = new Map<string, SessionState>()
  private readonly pending = new Map<string, DecisionEnvelope[]>()
  /** 每个会话最近若干条文本，只用于统计语气和找重复出现的说法。 */
  private readonly observed = new Map<string, QqObservedMessage[]>()
  /** 200 条样本：活跃群一天就能刷满，样本太少画像会抖。 */
  private static readonly OBSERVED_LIMIT = 200
  private ws: QqBotWsClient | null = null
  private started = false
  private lastInboundKey = ''
  private lastError: Error | null = null
  private ready = false

  constructor(private readonly options: QqGatewayChannelOptions) {
    this.owners = new Set(
      (options.ownerOpenIds ?? []).map((id) => id.trim()).filter((id) => id.length > 0)
    )
    this.api =
      options.api ??
      new QqBotApiClient({ appId: options.appId, clientSecret: options.clientSecret })
    this.now = options.now ?? Date.now
    this.log = options.onLog ?? (() => undefined)
  }

  capabilities(): ChannelCapabilities {
    return { approval: true, question: true, richCard: false, memorySync: false }
  }

  /**
   * 最近几条消息，只给「这群人怎么说话」做统计。
   * 只存在内存里，重启就清空；调用方不该把它写进记忆或日志。
   */
  recentMessages(key: string, limit = 40): readonly QqObservedMessage[] {
    const list = this.observed.get(key) ?? []
    const size = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 40
    return list.slice(-size)
  }

  /** 记一条观察样本；超出上限时丢最旧的。 */
  private observe(
    key: string,
    speaker: string,
    text: string,
    extra?: { mentioned?: boolean; imageCount?: number }
  ): void {
    const list = this.observed.get(key) ?? []
    const rawImages = extra?.imageCount
    list.push({
      speaker,
      text: text.slice(0, 200),
      at: this.now(),
      mentioned: extra?.mentioned === true,
      imageCount: Number.isFinite(rawImages) ? Math.max(0, Math.floor(Number(rawImages))) : 0
    })
    if (list.length > QqGatewayChannel.OBSERVED_LIMIT) {
      list.splice(0, list.length - QqGatewayChannel.OBSERVED_LIMIT)
    }
    this.observed.set(key, list)
  }

  onReply(handler: (reply: DecisionReply) => void): () => void {
    this.handlers.add(handler)
    return () => {
      this.handlers.delete(handler)
    }
  }

  /** 订阅连接就绪状态；只在状态真正变化时触发。 */
  onReadyChange(handler: (ready: boolean) => void): () => void {
    this.readyHandlers.add(handler)
    return () => {
      this.readyHandlers.delete(handler)
    }
  }

  get isReady(): boolean {
    return this.ready
  }

  /** 建立网关连接；重复调用不会叠第二条。 */
  async start(): Promise<void> {
    if (this.started) return
    if (this.options.appId === '' || this.options.clientSecret === '') {
      throw new PetError(ErrorCode.CHANNEL_NOT_CONFIGURED, 'QQ 网关缺少 AppID / AppSecret')
    }

    const gatewayUrl = this.options.gatewayUrl ?? (await this.api.getGatewayUrl())
    const client = new QqBotWsClient({
      gatewayUrl,
      getAccessToken: () => this.api.getAccessToken(),
      onDispatch: (type, data) => this.handleDispatch(type, data),
      onReadyChange: (ready) => {
        this.ready = ready
        for (const handler of this.readyHandlers) handler(ready)
        this.log(ready ? '[qq] 网关已连接' : '[qq] 网关已断开')
      },
      onError: (error) => {
        this.lastError = error
        this.log(`[qq] 网关错误：${error.message}`)
        this.options.onError?.(error)
      },
      ...(this.options.websocketFactory === undefined
        ? {}
        : { websocketFactory: this.options.websocketFactory }),
      ...(this.options.maxBackoffMs === undefined
        ? {}
        : { maxBackoffMs: this.options.maxBackoffMs })
    })
    this.ws = client
    this.started = true
    await client.start()
  }

  async stop(): Promise<void> {
    this.started = false
    this.ready = false
    const ws = this.ws
    this.ws = null
    if (ws !== null) await ws.stop()
  }

  async send(envelope: DecisionEnvelope): Promise<ChannelSendResult> {
    if (envelope.expiresAt <= this.now()) {
      throw new PetError(ErrorCode.CHANNEL_UNREACHABLE, 'QQ 审批卡片已过期，不再发送')
    }

    const session = this.resolveSession()
    if (session !== null && this.canReply(session)) {
      await this.deliver(session, envelope)
      return { messageId: envelope.id }
    }

    // 没有可用入站消息：进入待发队列，返回 queued 让调用方知道没有真正送达。
    const key = session?.key ?? this.fallbackQueueKey()
    const queue = this.pending.get(key) ?? []
    queue.push(envelope)
    this.pending.set(key, queue)
    this.log(`[qq] 无可用入站消息，卡片 ${envelope.id} 已排队（${key}）`)
    return { messageId: envelope.id, queued: true }
  }

  /**
   * 用当前被动回复窗口发一条普通文本。
   * 只对已有入站会话有效；窗口过期或次数用尽时返回 false，不排队。
   */
  async replyText(
    chatType: 'private' | 'group',
    openId: string,
    content: string
  ): Promise<boolean> {
    const text = content.trim()
    if (text === '') return false

    const session = this.sessions.get(`${chatType}:${openId}`)
    if (session === undefined || !this.canReply(session)) {
      this.log(`[qq] 不回复 ${chatType}:${openId}：不在被动回复窗口或次数已用尽`)
      return false
    }

    try {
      await this.api.sendText(
        { openid: session.openId, chatType: session.chatType },
        text.slice(0, 1000),
        { msgId: session.lastMsgId, msgSeq: session.replyCount + 1 }
      )
      session.replyCount += 1
      return true
    } catch (error) {
      this.log(
        `[qq] 聊天回复失败：${error instanceof Error ? error.message : String(error)}`
      )
      return false
    }
  }

  /**
   * 用当前被动回复窗口发一张图片。
   * 失败原因会写日志并回 false；调用方据此给用户一句人话。
   */
  async replyImage(contentType: string, bytes: Uint8Array): Promise<boolean> {
    if (bytes.byteLength === 0) return false
    if (this.api.sendImage === undefined) {
      this.log('[qq] 当前 API 客户端不支持发图')
      return false
    }

    const session = this.resolveSession()
    if (session === undefined || session === null || !this.canReply(session)) {
      this.log('[qq] 不发图：没有可用的被动回复会话或次数已用尽')
      return false
    }

    try {
      await this.api.sendImage(
        { openid: session.openId, chatType: session.chatType },
        { contentType, bytes },
        { msgId: session.lastMsgId, msgSeq: session.replyCount + 1 }
      )
      session.replyCount += 1
      return true
    } catch (error) {
      this.log(`[qq] 发图失败：${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }

  async health(): Promise<DiagResult> {
    if (this.options.appId === '' || this.options.clientSecret === '') {
      return {
        ok: false,
        code: ErrorCode.CHANNEL_NOT_CONFIGURED,
        message: '未配置 QQ AppID / AppSecret'
      }
    }
    if (this.owners.size === 0) {
      return {
        ok: false,
        code: ErrorCode.CHANNEL_NOT_CONFIGURED,
        message: '未配置主人 openid，不会接受任何远程拍板'
      }
    }
    if (!this.started || this.ws === null) {
      return {
        ok: false,
        code: ErrorCode.CHANNEL_UNREACHABLE,
        message: 'QQ 网关尚未启动'
      }
    }
    if (!this.ready) {
      return {
        ok: false,
        code: ErrorCode.CHANNEL_UNREACHABLE,
        message: this.lastError?.message ?? 'QQ 网关未就绪'
      }
    }
    return { ok: true, message: 'QQ 网关可用' }
  }

  /** 供诊断与测试：当前排队的卡片数量。 */
  pendingCount(): number {
    let total = 0
    for (const queue of this.pending.values()) total += queue.length
    return total
  }

  private handleDispatch(type: QqBotEventType, data: Record<string, unknown>): void {
    // 进群 / 退群不是消息，但它决定了之后还有没有消息可收。
    // 先把这一笔写进日志，群里突然安静时才不用靠猜。
    if (type === 'GROUP_ADD_ROBOT' || type === 'GROUP_DEL_ROBOT') {
      const groupOpenId = textOf(data['group_openid'])
      const operatorOpenId = textOf(data['op_member_openid'])
      const added = type === 'GROUP_ADD_ROBOT'
      this.log(
        added
          ? `[qq] 机器人已进群 group=${groupOpenId}`
          : `[qq] 机器人已被移出群 group=${groupOpenId}`
      )
      this.options.onSystemEvent?.({
        type,
        groupOpenId,
        operatorOpenId,
        at: this.now()
      })
      return
    }

    if (
      type !== 'C2C_MESSAGE_CREATE' &&
      type !== 'GROUP_AT_MESSAGE_CREATE' &&
      type !== 'GROUP_MESSAGE_CREATE'
    ) {
      return
    }

    const sender = senderOpenId(data)
    const msgId = textOf(data['id'])
    if (sender === '' || msgId === '') return

    const groupOpenId =
      type === 'C2C_MESSAGE_CREATE' ? '' : textOf(data['group_openid'])
    const chatType: 'private' | 'group' = groupOpenId === '' ? 'private' : 'group'
    const openId = chatType === 'group' ? groupOpenId : sender
    const key = `${chatType}:${openId}`
    const isOwner = this.owners.has(sender)
    // 平台只会把明确叫到机器人的群消息推成 GROUP_AT_MESSAGE_CREATE。
    const mentioned = type === 'GROUP_AT_MESSAGE_CREATE'
    const content = mentioned
      ? stripMentions(textOf(data['content']))
      : textOf(data['content'])
    // 图片 / 表情包只数数量，不下载、不保存；用来估计这群人有多爱发表情。
    const attachments = Array.isArray(data['attachments']) ? data['attachments'] : []
    const imageCount = attachments.filter((item) => {
      if (item === null || typeof item !== 'object') return false
      const type = textOf((item as Record<string, unknown>)['content_type'])
      return type.startsWith('image') || type === 'sticker'
    }).length

    const session = this.upsertSession(key, chatType, openId, sender, msgId)
    this.lastInboundKey = key
    this.log(`[qq] 入站 ${key} msg=${msgId}`)
    // 先记一条观察样本：不管是不是主人、回不回复，都能学到这群人怎么说话。
    if (content !== '') this.observe(key, sender, content, { mentioned, imageCount })

    // 观察模式要先拿到来源，才能让用户在设置页绑定主人；这里不吃主人名单。
    // 顺带把原文交给宿主：群聊里有人只是叫了名字时，宿主才有机会轻轻应一声。
    this.options.onInbound?.({
      chatType,
      openId,
      senderOpenId: sender,
      ...(content === '' ? {} : { content }),
      msgId,
      ...(mentioned ? { mentioned: true } : {}),
      ...(isOwner ? { isOwner: true } : {})
    })

    // 首条消息前 send() 只能把卡片挂在 unbound 上；有了会话就把它接过来，
    // 否则这些卡片会永远等不到 flush。
    const unbound = this.pending.get('unbound')
    if (unbound !== undefined && unbound.length > 0) {
      this.pending.delete('unbound')
      const current = this.pending.get(key) ?? []
      this.pending.set(key, [...unbound, ...current])
    }

    // 先补发之前排队的卡片；补发会消耗这次的被动回复次数。
    void this.flush(session)

    const images = imagesOf(data)
    // 纯图片消息没有文本，也要交给宿主；否则偷表情包永远收不到。
    if (content === '' && images.length === 0) return

    // 群里被 @ 是明确在叫她，任何人都该得到回应；私聊与普通群消息仍只接受主人。
    if (!isOwner && !mentioned) return

    this.options.onMessage?.({
      chatType,
      openId,
      senderOpenId: sender,
      content,
      msgId,
      images,
      ...(mentioned ? { mentioned: true } : {}),
      ...(isOwner ? { isOwner: true } : {})
    })

    // 非主人只能聊天，不能拍板。
    if (!isOwner) return

    // 没有文本就没有可解析的指令，到此为止。
    if (content === '') return
    const parsed = this.parseCommand(content)
    if (parsed === null) return

    const reply: DecisionReply = {
      envelopeId: parsed.id,
      action: parsed.action,
      decidedAt: this.now(),
      sig: '',
      sender: { channelId: this.id, id: sender, chatType },
      ...(parsed.answer === undefined ? {} : { answer: parsed.answer })
    }
    for (const handler of this.handlers) handler(reply)
  }

  private upsertSession(
    key: string,
    chatType: 'private' | 'group',
    openId: string,
    senderOpenIdValue: string,
    msgId: string
  ): SessionState {
    const existing = this.sessions.get(key)
    if (existing !== undefined && existing.lastMsgId === msgId) return existing

    const next: SessionState = {
      key,
      chatType,
      openId,
      senderOpenId: senderOpenIdValue,
      lastMsgId: msgId,
      lastAt: this.now(),
      replyCount: 0
    }
    this.sessions.set(key, next)
    return next
  }

  private resolveSession(): SessionState | null {
    const target = this.options.targetOpenId ?? ''
    if (target !== '') {
      return this.sessions.get(`private:${target}`) ?? null
    }
    if (this.lastInboundKey !== '') {
      return this.sessions.get(this.lastInboundKey) ?? null
    }
    return null
  }

  private fallbackQueueKey(): string {
    const target = this.options.targetOpenId ?? ''
    return target === '' ? 'unbound' : `private:${target}`
  }

  private windowMs(chatType: 'private' | 'group'): number {
    return chatType === 'group' ? GROUP_WINDOW_MS : PRIVATE_WINDOW_MS
  }

  private maxReplies(chatType: 'private' | 'group'): number {
    return chatType === 'group' ? GROUP_MAX_REPLIES : PRIVATE_MAX_REPLIES
  }

  private canReply(session: SessionState): boolean {
    if (session.lastMsgId === '') return false
    if (this.now() - session.lastAt > this.windowMs(session.chatType)) return false
    return session.replyCount < this.maxReplies(session.chatType)
  }

  private async deliver(session: SessionState, envelope: DecisionEnvelope): Promise<void> {
    const content = formatEnvelope(envelope, this.now())
    await this.api.sendText(
      { openid: session.openId, chatType: session.chatType },
      content,
      { msgId: session.lastMsgId, msgSeq: session.replyCount + 1 }
    )
    session.replyCount += 1
  }

  private async flush(session: SessionState): Promise<void> {
    const queue = this.pending.get(session.key)
    if (queue === undefined || queue.length === 0) return

    while (queue.length > 0) {
      const envelope = queue[0]
      if (envelope === undefined) break
      if (envelope.expiresAt <= this.now()) {
        queue.shift()
        this.log(`[qq] 卡片 ${envelope.id} 已过期，丢弃`)
        continue
      }
      if (!this.canReply(session)) break
      queue.shift()
      try {
        await this.deliver(session, envelope)
      } catch (error) {
        queue.unshift(envelope)
        this.log(
          `[qq] 补发失败：${error instanceof Error ? error.message : String(error)}`
        )
        break
      }
    }
    if (queue.length === 0) this.pending.delete(session.key)
  }

  private parseCommand(
    content: string
  ): { id: string; action: DecisionAction; answer?: string } | null {
    const match =
      /^\s*(allow|deny|answer|同意|拒绝|忽略)\s+([0-9a-z]{6,32})(?:\s+([\s\S]+))?$/i.exec(
        content.trim()
      )
    if (match === null) return null
    const verb = (match[1] ?? '').toLowerCase()
    const id = match[2] ?? ''
    const rest = match[3]?.trim()
    const action: DecisionAction =
      verb === 'allow' || verb === '同意'
        ? 'allow'
        : verb === 'deny' || verb === '拒绝'
          ? 'deny'
          : verb === '忽略'
            ? 'dismiss'
            : 'answer'
    if (action === 'answer' && (rest === undefined || rest.length === 0)) return null
    return { id, action, ...(rest === undefined ? {} : { answer: rest }) }
  }
}
