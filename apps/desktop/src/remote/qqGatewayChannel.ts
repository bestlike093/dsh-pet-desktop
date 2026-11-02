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
import type { QqBotSendOptions, QqBotSendTarget } from './qqbot-api-client.js'
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

function senderOpenId(data: Record<string, unknown>): string {
  const author = isRecord(data['author']) ? data['author'] : {}
  for (const key of ['user_openid', 'member_openid', 'openid']) {
    const value = textOf(author[key])
    if (value !== '') return value
  }
  return ''
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
    if (
      type !== 'C2C_MESSAGE_CREATE' &&
      type !== 'GROUP_AT_MESSAGE_CREATE' &&
      type !== 'GROUP_MESSAGE_CREATE'
    ) {
      return
    }

    const sender = senderOpenId(data)
    const content = textOf(data['content'])
    const msgId = textOf(data['id'])
    if (sender === '' || msgId === '') return

    const groupOpenId =
      type === 'C2C_MESSAGE_CREATE' ? '' : textOf(data['group_openid'])
    const chatType: 'private' | 'group' = groupOpenId === '' ? 'private' : 'group'
    const openId = chatType === 'group' ? groupOpenId : sender
    const key = `${chatType}:${openId}`

    const session = this.upsertSession(key, chatType, openId, sender, msgId)
    this.lastInboundKey = key
    this.log(`[qq] 入站 ${key} msg=${msgId}`)

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

    if (content === '' || !this.owners.has(sender)) return
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
