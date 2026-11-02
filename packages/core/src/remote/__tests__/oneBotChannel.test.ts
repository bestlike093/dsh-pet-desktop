import { describe, expect, it } from 'vitest'
import { ErrorCode, PetError } from '@pet/shared'
import type { DecisionEnvelope, DecisionReply } from '@pet/shared'
import { OneBotChannel } from '../oneBotChannel.js'

type Listener = (event: unknown) => void

/** 假 socket：记录发帧、支持同步回帧，不碰网络。 */
class FakeSocket {
  readyState = 1
  readonly sent: string[] = []
  private readonly listeners = new Map<string, Set<Listener>>()
  respond: ((frame: Record<string, unknown>) => void) | undefined

  send(data: string): void {
    this.sent.push(data)
    const frame = JSON.parse(data) as Record<string, unknown>
    this.respond?.(frame)
  }

  close(): void {
    this.readyState = 3
  }

  addEventListener(type: string, handler: Listener): void {
    const set = this.listeners.get(type) ?? new Set<Listener>()
    set.add(handler)
    this.listeners.set(type, set)
  }

  emit(type: string, event: unknown): void {
    const set = this.listeners.get(type)
    if (set === undefined) return
    for (const handler of set) handler(event)
  }

  /** 模拟协议端回一帧 JSON。 */
  push(frame: unknown): void {
    this.emit('message', { data: JSON.stringify(frame) })
  }

  lastFrame(): Record<string, unknown> {
    const raw = this.sent.at(-1)
    if (raw === undefined) throw new Error('没有发出任何帧')
    return JSON.parse(raw) as Record<string, unknown>
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

function channel(socket: FakeSocket, overrides: { target?: { type: 'group' | 'private'; id: string } } = {}): OneBotChannel {
  return new OneBotChannel({
    url: 'ws://127.0.0.1:3001',
    target: overrides.target ?? { type: 'group', id: '1043429671' },
    socketFactory: () => socket
  })
}

describe('OneBot 通道：投递与回收', () => {
  it('投递到群时用 send_group_msg，正文只带摘要与编号', async () => {
    const socket = new FakeSocket()
    socket.respond = (frame) => {
      socket.push({ echo: frame['echo'], retcode: 0, data: { message_id: 9001 } })
    }
    const ch = channel(socket)

    const result = await ch.send(envelope())

    expect(result.messageId).toBe('9001')
    const frame = socket.lastFrame()
    expect(frame['action']).toBe('send_group_msg')
    const params = frame['params'] as Record<string, unknown>
    expect(params['group_id']).toBe('1043429671')
    const message = params['message'] as Array<{ type: string; data: Record<string, string> }>
    expect(message[0]?.type).toBe('text')
    expect(message[0]?.data['text']).toContain('是否允许模块读取剪贴板')
    expect(message[0]?.data['text']).toContain('#a1b2c3d4')
  })

  it('私聊目标用 send_private_msg 与 user_id', async () => {
    const socket = new FakeSocket()
    socket.respond = (frame) => {
      socket.push({ echo: frame['echo'], retcode: 0, data: { message_id: 7 } })
    }
    const ch = channel(socket, { target: { type: 'private', id: '1054051147' } })

    await ch.send(envelope())

    const frame = socket.lastFrame()
    expect(frame['action']).toBe('send_private_msg')
    expect((frame['params'] as Record<string, unknown>)['user_id']).toBe('1054051147')
  })

  it('连通时 health 为 ok', async () => {
    const ch = channel(new FakeSocket())

    const diag = await ch.health()

    expect(diag.ok).toBe(true)
  })

  it('未连接时 send 抛 CHANNEL_UNREACHABLE', async () => {
    const socket = new FakeSocket()
    socket.readyState = 3
    const ch = channel(socket)

    await expect(ch.send(envelope())).rejects.toMatchObject({ code: ErrorCode.CHANNEL_UNREACHABLE })
  })

  it('dispose 后 send 抛 NOT_SUPPORTED', async () => {
    const ch = channel(new FakeSocket())
    ch.dispose()

    await expect(ch.send(envelope())).rejects.toBeInstanceOf(PetError)
  })
})

describe('OneBot 通道：回复解析', () => {
  it('文本带 #编号 时直接对回信封', () => {
    const socket = new FakeSocket()
    const ch = channel(socket)
    const replies: DecisionReply[] = []
    ch.onReply((reply) => replies.push(reply))

    socket.push({
      post_type: 'message',
      message_type: 'private',
      user_id: 10001,
      message: [{ type: 'text', data: { text: '#a1b2c3d4 allow' } }]
    })

    expect(replies).toHaveLength(1)
    expect(replies[0]?.envelopeId).toBe('a1b2c3d4')
    expect(replies[0]?.action).toBe('allow')
    expect(replies[0]?.sender).toEqual({
      channelId: 'qq',
      id: '10001',
      chatType: 'private'
    })
  })

  it('answer 带内容时一并带回', () => {
    const socket = new FakeSocket()
    const ch = channel(socket)
    const replies: DecisionReply[] = []
    ch.onReply((reply) => replies.push(reply))

    socket.push({
      post_type: 'message',
      message_type: 'private',
      user_id: 10001,
      message: [{ type: 'text', data: { text: '#a1b2c3d4 answer 允许一次' } }]
    })

    expect(replies[0]?.action).toBe('answer')
    expect(replies[0]?.answer).toBe('允许一次')
  })

  it('引用回复用 message_id 反查信封', async () => {
    const socket = new FakeSocket()
    socket.respond = (frame) => {
      socket.push({ echo: frame['echo'], retcode: 0, data: { message_id: 9001 } })
    }
    const ch = channel(socket)
    const replies: DecisionReply[] = []
    ch.onReply((reply) => replies.push(reply))
    await ch.send(envelope())

    socket.push({
      post_type: 'message',
      message_type: 'group',
      user_id: 20002,
      message: [
        { type: 'reply', data: { id: '9001' } },
        { type: 'text', data: { text: 'deny' } }
      ]
    })

    expect(replies[0]?.envelopeId).toBe('a1b2c3d4')
    expect(replies[0]?.action).toBe('deny')
    expect(replies[0]?.sender?.chatType).toBe('group')
  })

  it('缺少 user_id 时不产出匿名回复', () => {
    const socket = new FakeSocket()
    const ch = channel(socket)
    const replies: DecisionReply[] = []
    ch.onReply((reply) => replies.push(reply))

    socket.push({
      post_type: 'message',
      message_type: 'private',
      message: [{ type: 'text', data: { text: '#a1b2c3d4 allow' } }]
    })

    expect(replies).toHaveLength(0)
  })

  it('无关文本不产生回复', () => {
    const socket = new FakeSocket()
    const ch = channel(socket)
    const replies: DecisionReply[] = []
    ch.onReply((reply) => replies.push(reply))

    socket.push({ post_type: 'message', message: [{ type: 'text', data: { text: '今天天气不错' } }] })
    socket.push({ post_type: 'notice', message: [] })

    expect(replies).toHaveLength(0)
  })

  it('取消订阅后不再收到回复', () => {
    const socket = new FakeSocket()
    const ch = channel(socket)
    const replies: DecisionReply[] = []
    const off = ch.onReply((reply) => replies.push(reply))
    off()

    socket.push({ post_type: 'message', message: [{ type: 'text', data: { text: '#a1b2c3d4 allow' } }] })

    expect(replies).toHaveLength(0)
  })
})
