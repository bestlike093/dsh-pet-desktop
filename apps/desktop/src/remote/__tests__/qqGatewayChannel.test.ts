import { describe, expect, it, vi } from 'vitest'
import type { DecisionEnvelope, DecisionReply } from '@pet/shared'
import { QqGatewayChannel } from '../qqGatewayChannel.js'
import type { QqGatewayApi } from '../qqGatewayChannel.js'
import type { WebSocketClient } from '../websocket-client.js'

type Listener = (...args: any[]) => void

/** 假 WS：只记录发帧、手动回帧，不碰网络。 */
class FakeSocket {
  readyState = 1
  readonly sent: string[] = []
  private readonly listeners = new Map<string, Set<Listener>>()

  on(event: string, listener: Listener): this {
    const set = this.listeners.get(event) ?? new Set<Listener>()
    set.add(listener)
    this.listeners.set(event, set)
    return this
  }

  removeAllListeners(): this {
    this.listeners.clear()
    return this
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    if (this.readyState === 3) return
    this.readyState = 3
    this.emit('close')
  }

  terminate(): void {
    this.close()
  }

  push(payload: Record<string, unknown>): void {
    this.emit('message', JSON.stringify(payload))
  }

  handshake(): void {
    this.push({ op: 10, d: { heartbeat_interval: 60_000 } })
    this.push({ op: 0, t: 'READY', s: 1, d: { session_id: 'session-1' } })
  }

  lastSent(): Record<string, unknown> | null {
    const raw = this.sent.at(-1)
    return raw === undefined ? null : (JSON.parse(raw) as Record<string, unknown>)
  }

  private emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args)
  }
}

function envelope(overrides: Partial<DecisionEnvelope> = {}): DecisionEnvelope {
  return {
    id: 'a1b2c3d4',
    kind: 'approval',
    deviceId: 'dev-1',
    hlc: '000001',
    nonce: 'n-1',
    expiresAt: Date.now() + 60_000,
    summary: '是否允许模块读取剪贴板',
    payloadCipher: 'plain:e30=',
    sig: '',
    keyEpoch: 0,
    ...overrides
  }
}

function fakeApi(): QqGatewayApi & {
  sendText: ReturnType<typeof vi.fn>
} {
  return {
    getAccessToken: vi.fn(async () => 'token'),
    getGatewayUrl: vi.fn(async () => 'wss://api.sgroup.qq.com/websocket'),
    sendText: vi.fn(async () => undefined)
  }
}

async function readyChannel(options: {
  api?: QqGatewayApi
  socket?: FakeSocket
  ownerOpenIds?: string[]
  now?: () => number
} = {}): Promise<{
  channel: QqGatewayChannel
  socket: FakeSocket
  api: QqGatewayApi
}> {
  const socket = options.socket ?? new FakeSocket()
  const api = options.api ?? fakeApi()
  const channel = new QqGatewayChannel({
    appId: 'app-id',
    clientSecret: 'secret',
    ownerOpenIds: options.ownerOpenIds ?? ['owner'],
    api,
    websocketFactory: () => socket as unknown as WebSocketClient,
    now: options.now ?? (() => Date.now())
  })
  await channel.start()
  socket.handshake()
  return { channel, socket, api }
}

describe('QqGatewayChannel', () => {
  it('配置缺失时 health 为 CHANNEL_NOT_CONFIGURED', async () => {
    const channel = new QqGatewayChannel({
      appId: '',
      clientSecret: '',
      ownerOpenIds: ['owner']
    })
    await expect(channel.health()).resolves.toMatchObject({
      ok: false,
      code: 'CHANNEL_NOT_CONFIGURED'
    })
  })

  it('未启动时 health 为 CHANNEL_UNREACHABLE', async () => {
    const channel = new QqGatewayChannel({
      appId: 'app-id',
      clientSecret: 'secret',
      ownerOpenIds: ['owner'],
      api: fakeApi()
    })
    await expect(channel.health()).resolves.toMatchObject({
      ok: false,
      code: 'CHANNEL_UNREACHABLE'
    })
  })

  it('握手完成后 health 为 ok', async () => {
    const { channel, socket } = await readyChannel()
    expect(socket.lastSent()).toMatchObject({ op: 2 })
    await expect(channel.health()).resolves.toMatchObject({ ok: true })
  })

  it('主人 C2C 消息生成带 channelId 的 DecisionReply', async () => {
    const { channel, socket } = await readyChannel()
    const replies: DecisionReply[] = []
    channel.onReply((reply) => replies.push(reply))

    socket.push({
      op: 0,
      s: 2,
      t: 'C2C_MESSAGE_CREATE',
      d: { id: 'm1', content: 'allow abc123', author: { user_openid: 'owner' } }
    })

    expect(replies).toHaveLength(1)
    expect(replies[0]).toMatchObject({
      envelopeId: 'abc123',
      action: 'allow',
      sender: { channelId: 'qq', id: 'owner', chatType: 'private' }
    })
  })

  it('非主人的消息不产生回复', async () => {
    const { channel, socket } = await readyChannel()
    const replies: DecisionReply[] = []
    channel.onReply((reply) => replies.push(reply))

    socket.push({
      op: 0,
      s: 2,
      t: 'C2C_MESSAGE_CREATE',
      d: { id: 'm1', content: 'allow abc123', author: { user_openid: 'stranger' } }
    })

    expect(replies).toHaveLength(0)
  })

  it('有入站消息时立即被动回复，msg_seq 递增', async () => {
    const { channel, socket, api } = await readyChannel()
    socket.push({
      op: 0,
      s: 2,
      t: 'C2C_MESSAGE_CREATE',
      d: { id: 'm1', content: 'hello', author: { user_openid: 'owner' } }
    })

    const first = await channel.send(envelope())
    const second = await channel.send(envelope({ id: 'e5f6a7b8' }))

    expect(first).toEqual({ messageId: 'a1b2c3d4' })
    expect(second).toEqual({ messageId: 'e5f6a7b8' })
    expect(api.sendText).toHaveBeenNthCalledWith(
      1,
      { openid: 'owner', chatType: 'private' },
      expect.stringContaining('allow a1b2c3d4'),
      { msgId: 'm1', msgSeq: 1 }
    )
    expect(api.sendText).toHaveBeenNthCalledWith(
      2,
      { openid: 'owner', chatType: 'private' },
      expect.stringContaining('deny e5f6a7b8'),
      { msgId: 'm1', msgSeq: 2 }
    )
  })

  it('首条消息前 send 只排队，不调用发送接口', async () => {
    const { channel, api } = await readyChannel()

    const result = await channel.send(envelope())

    expect(result).toEqual({ messageId: 'a1b2c3d4', queued: true })
    expect(api.sendText).not.toHaveBeenCalled()
    expect(channel.pendingCount()).toBe(1)
  })

  it('首条入站消息会把 unbound 队列接过来并补发', async () => {
    const { channel, socket, api } = await readyChannel()
    await channel.send(envelope())

    socket.push({
      op: 0,
      s: 2,
      t: 'C2C_MESSAGE_CREATE',
      d: { id: 'm1', content: 'hello', author: { user_openid: 'owner' } }
    })

    await vi.waitFor(() => expect(api.sendText).toHaveBeenCalledTimes(1))
    expect(api.sendText).toHaveBeenCalledWith(
      { openid: 'owner', chatType: 'private' },
      expect.stringContaining('allow a1b2c3d4'),
      { msgId: 'm1', msgSeq: 1 }
    )
    expect(channel.pendingCount()).toBe(0)
  })

  it('过期卡片在 flush 时丢弃，不发送', async () => {
    let now = Date.now()
    const { channel, socket, api } = await readyChannel({ now: () => now })
    await channel.send(envelope({ expiresAt: now + 1_000 }))
    now += 2_000

    socket.push({
      op: 0,
      s: 2,
      t: 'C2C_MESSAGE_CREATE',
      d: { id: 'm1', content: 'hello', author: { user_openid: 'owner' } }
    })

    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(api.sendText).not.toHaveBeenCalled()
    expect(channel.pendingCount()).toBe(0)
  })

  it('群消息从 group_openid 取投递地址，发送到群接口', async () => {
    const { channel, socket, api } = await readyChannel()
    socket.push({
      op: 0,
      s: 2,
      t: 'GROUP_AT_MESSAGE_CREATE',
      d: {
        id: 'm2',
        content: 'allow abc123',
        group_openid: 'group-1',
        author: { member_openid: 'owner' }
      }
    })

    await channel.send(envelope())

    expect(api.sendText).toHaveBeenCalledWith(
      { openid: 'group-1', chatType: 'group' },
      expect.any(String),
      { msgId: 'm2', msgSeq: 1 }
    )
  })
})
