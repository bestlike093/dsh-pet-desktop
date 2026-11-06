// QQ 官方机器人（QQ 开放平台 API v2）REST 客户端。
//
// 职责：
//   1) access_token 生命周期管理（getAppAccessToken + 过期前刷新 + 并发去重）
//   2) 被动回复消息发送（/v2/users/{openid}/messages 与 /v2/groups/{group_openid}/messages）
//   3) 网关地址查询（GET /gateway）
//
// 协议要点（官方文档 bot.q.qq.com/wiki api-v2）：
//   - token 端点：POST https://bots.qq.com/app/getAppAccessToken {appId, clientSecret}
//     → {access_token, expires_in}（秒，一般 7200）。无需 Basic Auth。
//   - 业务 API base：https://api.sgroup.qq.com，鉴权头 `Authorization: QQBot <token>`。
//   - 2025-04-21 后官方不再提供主动推送，所有发送都必须携带 msg_id（被动回复）。

export interface QqBotTokenProviderConfig {
  readonly appId: string
  readonly clientSecret: string
}

/** 可注入的 fetch（测试用）。签名与全局 fetch 一致。 */
export type QqBotFetch = (url: string, init?: RequestInit) => Promise<Response>

const TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken'
const API_BASE = 'https://api.sgroup.qq.com'
/** token 过期前 5 分钟刷新，避免边界抖动 */
const TOKEN_REFRESH_MARGIN_MS = 5 * 60_000

export interface QqBotSendTarget {
  /** private: 用户 openid；group: 群 openid */
  readonly openid: string
  readonly chatType: 'private' | 'group'
}

export interface QqBotSendOptions {
  /** 被动回复必须携带的入站消息 id */
  readonly msgId: string
  /** 同一 msg_id 的第几次回复（1 起，单聊上限 4 / 群上限 5） */
  readonly msgSeq: number
}

/** 待上传的图片字节；contentType 只用于调用方判断，协议本身只认图片。 */
export interface QqBotImagePayload {
  readonly contentType: string
  readonly bytes: Uint8Array
}

export class QqBotApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: unknown
  ) {
    super(message)
    this.name = 'QqBotApiError'
  }
}

export class QqBotApiClient {
  private token = ''
  private tokenExpiresAt = 0
  private tokenPromise: Promise<string> | null = null

  constructor(
    private readonly config: QqBotTokenProviderConfig,
    private readonly fetchFn: QqBotFetch = (url, init) => fetch(url, init)
  ) {}

  /** 拿一个有效 token（过期前 5 分钟自动刷新；并发调用共享同一次刷新）。 */
  async getAccessToken(): Promise<string> {
    const now = Date.now()
    if (this.token !== '' && now < this.tokenExpiresAt - TOKEN_REFRESH_MARGIN_MS) {
      return this.token
    }
    if (this.tokenPromise === null) {
      this.tokenPromise = this.refreshToken().finally(() => {
        this.tokenPromise = null
      })
    }
    return this.tokenPromise
  }

  private async refreshToken(): Promise<string> {
    const res = await this.fetchFn(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        appId: this.config.appId,
        clientSecret: this.config.clientSecret
      })
    })
    if (!res.ok) {
      throw new QqBotApiError(`获取 access_token 失败 (HTTP ${res.status})`, res.status)
    }
    const data = (await res.json()) as { access_token?: string; expires_in?: string | number }
    if (data.access_token === undefined || data.access_token === '') {
      throw new QqBotApiError('access_token 响应缺少 access_token', 200)
    }
    const expiresInSec = Number(data.expires_in ?? 7200)
    this.token = data.access_token
    this.tokenExpiresAt =
      Date.now() + (Number.isFinite(expiresInSec) ? expiresInSec : 7200) * 1000
    return this.token
  }

  /** 查询 WebSocket 网关地址。 */
  async getGatewayUrl(): Promise<string> {
    const data = await this.request<{ url?: string }>('/gateway')
    if (data.url === undefined || data.url === '') {
      throw new QqBotApiError('gateway 响应缺少 url', 200)
    }
    return data.url
  }

  /**
   * 被动回复一张图片：先上传富媒体拿 file_info，再发 msg_type 7。
   * 图片上限 5MB（腾讯限制），调用方应先自行检查；这里只负责协议。
   */
  async sendImage(
    target: QqBotSendTarget,
    image: QqBotImagePayload,
    options: QqBotSendOptions
  ): Promise<void> {
    const filesPath =
      target.chatType === 'group'
        ? `/v2/groups/${encodeURIComponent(target.openid)}/files`
        : `/v2/users/${encodeURIComponent(target.openid)}/files`

    const uploaded = await this.request<{ file_info?: string }>(filesPath, {
      method: 'POST',
      body: JSON.stringify({
        file_type: 1,
        // 官方接口接受 base64 的 file_data；不依赖图片有公网地址。
        file_data: Buffer.from(image.bytes).toString('base64'),
        srv_send_msg: false
      })
    })
    if (uploaded.file_info === undefined || uploaded.file_info === '') {
      throw new QqBotApiError('富媒体上传响应缺少 file_info', 200)
    }

    const messagesPath =
      target.chatType === 'group'
        ? `/v2/groups/${encodeURIComponent(target.openid)}/messages`
        : `/v2/users/${encodeURIComponent(target.openid)}/messages`
    await this.request(messagesPath, {
      method: 'POST',
      body: JSON.stringify({
        msg_type: 7,
        media: { file_info: uploaded.file_info },
        content: '',
        msg_id: options.msgId,
        msg_seq: options.msgSeq
      })
    })
  }

  /**
   * 被动回复一条文本消息。
   * msg_type 0 = 文本。富媒体需先走富媒体上传接口，当前版本只发文本。
   */
  async sendText(
    target: QqBotSendTarget,
    content: string,
    options: QqBotSendOptions
  ): Promise<void> {
    const path =
      target.chatType === 'group'
        ? `/v2/groups/${encodeURIComponent(target.openid)}/messages`
        : `/v2/users/${encodeURIComponent(target.openid)}/messages`
    await this.request(path, {
      method: 'POST',
      body: JSON.stringify({
        msg_type: 0,
        content,
        msg_id: options.msgId,
        msg_seq: options.msgSeq
      })
    })
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const token = await this.getAccessToken()
    const res = await this.fetchFn(`${API_BASE}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `QQBot ${token}`,
        ...(init?.headers ?? {})
      }
    })
    if (!res.ok) {
      let detail = ''
      try {
        const body = (await res.json()) as { code?: unknown; message?: unknown }
        detail =
          body.message !== undefined
            ? ` ${String(body.message)} (code ${String(body.code)})`
            : ''
      } catch {
        // 非 JSON 错误体，忽略
      }
      throw new QqBotApiError(
        `QQ Bot API ${path} 失败 (HTTP ${res.status})${detail}`,
        res.status
      )
    }
    // 204 / 空 body 场景
    const text = await res.text()
    return (text !== '' ? JSON.parse(text) : {}) as T
  }
}
