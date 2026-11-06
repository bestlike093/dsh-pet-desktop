// OneBot 11 正向 WebSocket 客户端（NapCat / Lagrange 等协议端）。
//
// 与官方 QQ 机器人通道的关键差别：
//   - 官方通道自 2025-04-21 起不再提供主动推送，发送必须带入站 msg_id；
//   - OneBot 的 send_private_msg / send_group_msg 不依赖入站消息，可以随时发。
//
// 协议（OneBot 11）：
//   服务端推送事件：{ post_type: 'message', message_type: 'private'|'group', ... }
//   客户端调用 API：{ action: 'send_private_msg', params: {...}, echo: '1' }
//   服务端回包：    { status: 'ok', retcode: 0, data: {...}, echo: '1' }
//
// 鉴权：access_token 走 URL query（本项目的 WebSocketClient 不支持自定义请求头）。
import type { WebSocketClient } from './websocket-client.js'
import { WebSocketClient as Socket } from './websocket-client.js'

export interface OneBotMessageSegment {
  readonly type: string
  readonly data?: Record<string, unknown>
}

/** 协议端推来的一条聊天消息，已经剥掉协议细节。 */
export interface OneBotInbound {
  readonly chatType: 'private' | 'group'
  /** 投递地址：私聊为对方 QQ 号，群为群号 */
  readonly peerId: string
  readonly userId: string
  readonly nickname: string
  readonly content: string
  /** 群里是否明确 @ 了机器人；私聊恒为 true。 */
  readonly mentioned: boolean
  readonly messageId: string
  readonly images: readonly { readonly url: string; readonly file: string }[]
}

export interface OneBotClientOptions {
  /** 协议端地址，例如 ws://127.0.0.1:3001 */
  readonly url: string
  readonly accessToken?: string
  /** 机器人自己的 QQ 号；用于过滤自己发的消息与识别 @。 */
  readonly selfId?: string
  readonly onMessage?: (message: OneBotInbound) => void
  /** 连接可用性变化；宿主据此在设置页显示状态。 */
  readonly onReadyChange?: (ready: boolean) => void
  readonly onError?: (error: Error) => void
  readonly onLog?: (message: string) => void
  readonly maxBackoffMs?: number
  readonly requestTimeoutMs?: number
  /** 测试注入 WebSocket 构造器 */
  readonly websocketFactory?: (url: string) => WebSocketClient
}

interface OneBotEvent {
  post_type?: string
  message_type?: string
  self_id?: number
  user_id?: number
  group_id?: number
  message?: unknown
  raw_message?: string
  message_id?: number
  sender?: { user_id?: number; nickname?: string; card?: string }
}

interface OneBotResponse {
  status?: string
  retcode?: number
  data?: unknown
  echo?: unknown
  wording?: string
  msg?: string
}

interface PendingCall {
  readonly resolve: (data: unknown) => void
  readonly reject: (error: Error) => void
  readonly timer: ReturnType<typeof setTimeout>
}

const DEFAULT_MAX_BACKOFF_MS = 60_000
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function idOf(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'string') return value.trim()
  return ''
}

/** 消息段既可能是数组（标准格式），也可能是一段纯文本（string 格式）。 */
function segmentsOf(message: unknown): OneBotMessageSegment[] {
  if (typeof message === 'string') {
    return message === '' ? [] : [{ type: 'text', data: { text: message } }]
  }
  if (!Array.isArray(message)) return []
  const segments: OneBotMessageSegment[] = []
  for (const item of message) {
    if (!isRecord(item)) continue
    const type = typeof item.type === 'string' ? item.type : ''
    if (type === '') continue
    const data = isRecord(item.data) ? item.data : undefined
    segments.push(data === undefined ? { type } : { type, data })
  }
  return segments
}

function textOf(segments: readonly OneBotMessageSegment[]): string {
  let text = ''
  for (const segment of segments) {
    if (segment.type !== 'text') continue
    const value = segment.data?.text
    if (typeof value === 'string') text += value
  }
  return text.trim()
}

function imagesOf(
  segments: readonly OneBotMessageSegment[]
): { url: string; file: string }[] {
  const images: { url: string; file: string }[] = []
  for (const segment of segments) {
    if (segment.type !== 'image') continue
    const url = segment.data?.url
    const file = segment.data?.file
    images.push({
      url: typeof url === 'string' ? url : '',
      file: typeof file === 'string' ? file : ''
    })
  }
  return images
}

function atSelf(segments: readonly OneBotMessageSegment[], selfId: string): boolean {
  if (selfId === '') return false
  for (const segment of segments) {
    if (segment.type !== 'at') continue
    if (idOf(segment.data?.qq) === selfId) return true
  }
  return false
}

/**
 * 正向 WebSocket：由本机主动连到 NapCat。
 * 断线后按 1s → 60s 退避重连；停止后不再重连。
 */
export class OneBotClient {
  private ws: WebSocketClient | null = null
  private stopped = false
  private ready = false
  private backoffMs = 1_000
  private echoSeq = 0
  private lastError: Error | null = null
  private readonly pending = new Map<string, PendingCall>()
  /** 每次 connect 递增；旧 socket 的迟到回调不能影响新一代连接。 */
  private generation = 0

  constructor(private readonly options: OneBotClientOptions) {}

  get isReady(): boolean {
    return this.ready
  }

  getLastError(): Error | null {
    return this.lastError
  }

  async start(): Promise<void> {
    this.stopped = false
    await this.connect()
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.ready = false
    this.options.onReadyChange?.(false)
    this.failPending(new Error('OneBot 客户端已停止'))
    const ws = this.ws
    this.ws = null
    if (ws !== null) ws.close()
  }

  /** 主动发私聊；返回是否确认送达协议端。 */
  async sendPrivate(userId: string, text: string): Promise<boolean> {
    return this.sendText('private', userId, text)
  }

  /** 主动发群消息；返回是否确认送达协议端。 */
  async sendGroup(groupId: string, text: string): Promise<boolean> {
    return this.sendText('group', groupId, text)
  }

  /**
   * 让 QQ 显示「正在输入」。NapCat 扩展接口，非标准 OneBot；不支持时静默失败。
   * event_type: 1 = 正在输入，0 = 取消。
   */
  async setInputStatus(userId: string, typing: boolean): Promise<boolean> {
    if (this.options.selfId === undefined || this.options.selfId === '') return false
    try {
      await this.call('set_input_status', {
        user_id: userId,
        event_type: typing ? 1 : 0
      })
      return true
    } catch {
      return false
    }
  }

  private async sendText(
    chatType: 'private' | 'group',
    peerId: string,
    content: string
  ): Promise<boolean> {
    const text = content.trim()
    if (text === '' || peerId === '') return false
    try {
      await this.call(chatType === 'private' ? 'send_private_msg' : 'send_group_msg', {
        [chatType === 'private' ? 'user_id' : 'group_id']: peerId,
        message: text
      })
      return true
    } catch (error) {
      this.log(
        `[onebot] ${chatType === 'private' ? '私聊' : '群'}消息发送失败：${
          error instanceof Error ? error.message : String(error)
        }`
      )
      return false
    }
  }

  private async connect(): Promise<void> {
    if (this.stopped) return
    const generation = this.generation + 1
    this.generation = generation

    const factory =
      this.options.websocketFactory ?? ((url: string) => new Socket(url) as WebSocketClient)
    let ws: WebSocketClient
    try {
      ws = factory(this.buildUrl())
    } catch (error) {
      this.handleFailure(error instanceof Error ? error : new Error(String(error)))
      return
    }
    this.ws = ws

    ws.on('message', (raw: string) => {
      if (generation !== this.generation) return
      this.handleRaw(raw)
    })
    ws.on('error', (error: Error) => {
      if (generation !== this.generation) return
      this.handleFailure(error)
    })
    ws.on('close', () => {
      if (generation !== this.generation) return
      this.markDisconnected()
      this.scheduleReconnect()
    })

    // WebSocketClient 构造即开始握手；等它进入 OPEN 再宣告可用。
    try {
      await this.waitOpen(generation)
      if (generation !== this.generation || this.stopped) return
      this.ready = true
      this.backoffMs = 1_000
      this.lastError = null
      this.options.onReadyChange?.(true)
      this.log('[onebot] 已连接')
    } catch (error) {
      this.handleFailure(error instanceof Error ? error : new Error(String(error)))
    }
  }

  private buildUrl(): string {
    const token = this.options.accessToken?.trim() ?? ''
    if (token === '') return this.options.url
    const separator = this.options.url.includes('?') ? '&' : '?'
    return `${this.options.url}${separator}access_token=${encodeURIComponent(token)}`
  }

  private waitOpen(generation: number): Promise<void> {
    const timeoutMs = this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    const deadline = Date.now() + timeoutMs
    return new Promise((resolve, reject) => {
      const tick = (): void => {
        if (generation !== this.generation) {
          reject(new Error('OneBot 连接已被新的连接取代'))
          return
        }
        const ws = this.ws
        if (ws === null) {
          reject(new Error('OneBot WebSocket 已断开'))
          return
        }
        if (ws.readyState === Socket.OPEN) {
          resolve()
          return
        }
        if (ws.readyState === Socket.CLOSED) {
          reject(new Error('OneBot WebSocket 连接失败'))
          return
        }
        if (Date.now() > deadline) {
          reject(new Error('OneBot WebSocket 连接超时'))
          return
        }
        setTimeout(tick, 50)
      }
      tick()
    })
  }

  private markDisconnected(): void {
    if (!this.ready) return
    this.ready = false
    this.options.onReadyChange?.(false)
  }

  private scheduleReconnect(): void {
    if (this.stopped) return
    const delay = this.backoffMs
    this.backoffMs = Math.min(this.backoffMs * 2, this.options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS)
    this.log(`[onebot] 连接断开，${delay}ms 后重连`)
    setTimeout(() => {
      if (this.stopped) return
      void this.connect()
    }, delay)
  }

  private handleFailure(error: Error): void {
    this.lastError = error
    this.options.onError?.(error)
    this.log(`[onebot] ${error.message}`)
    this.markDisconnected()
    const ws = this.ws
    this.ws = null
    if (ws !== null) ws.close()
    this.scheduleReconnect()
  }

  private handleRaw(raw: string): void {
    let payload: unknown
    try {
      payload = JSON.parse(raw)
    } catch {
      return
    }
    if (!isRecord(payload)) return

    // 先处理 API 回包，再处理事件；回包里也可能带 post_type，但 echo 优先。
    const echo = payload.echo
    if (echo !== undefined && echo !== null) {
      this.settle(String(echo), payload as OneBotResponse)
      return
    }
    this.handleEvent(payload as OneBotEvent)
  }

  private settle(echo: string, response: OneBotResponse): void {
    const pending = this.pending.get(echo)
    if (pending === undefined) return
    this.pending.delete(echo)
    clearTimeout(pending.timer)
    if (response.status === 'failed' || (typeof response.retcode === 'number' && response.retcode !== 0)) {
      const reason = response.wording ?? response.msg ?? `retcode=${response.retcode ?? 'unknown'}`
      pending.reject(new Error(`OneBot API 返回失败：${reason}`))
      return
    }
    pending.resolve(response.data)
  }

  private handleEvent(event: OneBotEvent): void {
    if (event.post_type !== 'message') return
    const selfId = this.options.selfId ?? idOf(event.self_id)
    const segments = segmentsOf(event.message)
    const content = textOf(segments) || (event.raw_message ?? '')
    const images = imagesOf(segments)
    const userId = idOf(event.user_id)

    if (event.message_type === 'private') {
      if (userId === '' || userId === selfId) return
      this.options.onMessage?.({
        chatType: 'private',
        peerId: userId,
        userId,
        nickname: event.sender?.nickname ?? '',
        content,
        mentioned: true,
        messageId: idOf(event.message_id),
        images
      })
      return
    }

    if (event.message_type === 'group') {
      const groupId = idOf(event.group_id)
      if (groupId === '' || userId === '') return
      // 自己说的话不回流，避免自问自答。
      if (userId === selfId) return
      this.options.onMessage?.({
        chatType: 'group',
        peerId: groupId,
        userId,
        nickname: event.sender?.card ?? event.sender?.nickname ?? '',
        content,
        mentioned: atSelf(segments, selfId),
        messageId: idOf(event.message_id),
        images
      })
    }
  }

  private async call(action: string, params: Record<string, unknown>): Promise<unknown> {
    await this.waitOpen(this.generation)
    const ws = this.ws
    if (ws === null || ws.readyState !== Socket.OPEN) {
      throw new Error('OneBot 未连接')
    }
    const echo = String((this.echoSeq += 1))
    const timeoutMs = this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo)
        reject(new Error(`OneBot API 超时：${action}`))
      }, timeoutMs)
      this.pending.set(echo, { resolve, reject, timer })
      ws.send(JSON.stringify({ action, params, echo }))
    })
  }

  private failPending(error: Error): void {
    for (const [echo, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(error)
      this.pending.delete(echo)
    }
  }

  private log(message: string): void {
    this.options.onLog?.(message)
  }
}
