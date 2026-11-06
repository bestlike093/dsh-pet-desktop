import { describe, expect, it, vi } from 'vitest'
import { OneBotClient } from '../onebot-client.js'
import type { WebSocketClient } from '../websocket-client.js'

type Listener = (...args: any[]) => void

/** 假协议端：记录发出的帧，并能手动回包。 */
class FakeSocket {
  readyState = 1
  readonly sent: string[] = []
  readonly url: string
  private readonly listeners = new Map<string, Set<Listener>>()

  constructor(url: string) {
    this.url = url
  }

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
    this.readyState = 3
  }

  terminate(): void {
    this.readyState = 3
  }

  emit(event: string, ...args: any[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args)
  }

  push(payload: unknown): void {
    this.emit('message', JSON.stringify(payload))
  }

  /** 取出第 n 个请求的 echo，按协议端格式回一个成功包。 */
  ack(index = 0, data: unknown = {}): void {
    const raw = this.sent[index]
    if (raw === undefined) throw new Error(`没有第 ${index} 条请求`)
    const request = JSON.parse(raw) as { echo?: string }
    this.push({ status: 'ok', retcode: 0, data, echo: request.echo })
  }

  request(index = 0): { action?: string; params?: Record<string, unknown> } {
    const raw = this.sent[index]
    if (raw === undefined) throw new Error(`没有第 ${index} 条请求`)
    return JSON.parse(raw) as { action?: string; params?: Record<string, unknown> }
  }
}

interface Harness {
  client: OneBotClient
  socket: FakeSocket
  onMessage: ReturnType<typeof vi.fn>
  onReady: ReturnType<typeof vi.fn>
}

async function readyClient(
  options: { selfId?: string; accessToken?: string } = {}
): Promise<Harness> {
  const holder: { socket: FakeSocket | null } = { socket: null }
  const onMessage = vi.fn()
  const onReady = vi.fn()
  const client = new OneBotClient({
    url: 'ws://127.0.0.1:3001',
    ...(options.selfId === undefined ? {} : { selfId: options.selfId }),
    ...(options.accessToken === undefined ? {} : { accessToken: options.accessToken }),
    onMessage,
    onReadyChange: onReady,
    requestTimeoutMs: 2_000,
    websocketFactory: (url) => {
      const socket = new FakeSocket(url)
      holder.socket = socket
      return socket as unknown as WebSocketClient
    }
  })
  await client.start()
  const socket = holder.socket
  if (socket === null) throw new Error('没有创建 socket')
  return { client, socket, onMessage, onReady }
}

describe('OneBotClient', () => {
  it('连上后标记可用，并把 access_token 拼进 query', async () => {
    const { socket, onReady } = await readyClient({ accessToken: 'secret token' })
    expect(socket.url).toBe('ws://127.0.0.1:3001?access_token=secret%20token')
    expect(onReady).toHaveBeenCalledWith(true)
  })

  it('私聊消息解析文本与图片', async () => {
    const { socket, onMessage } = await readyClient({ selfId: '999' })
    socket.push({
      post_type: 'message',
      message_type: 'private',
      self_id: 999,
      user_id: 10001,
      message_id: 77,
      message: [
        { type: 'text', data: { text: '今天好累' } },
        { type: 'image', data: { url: 'https://example.com/a.png', file: 'a.png' } }
      ],
      sender: { nickname: '小满' }
    })

    expect(onMessage).toHaveBeenCalledTimes(1)
    expect(onMessage.mock.calls[0]?.[0]).toMatchObject({
      chatType: 'private',
      peerId: '10001',
      userId: '10001',
      nickname: '小满',
      content: '今天好累',
      mentioned: true,
      messageId: '77',
      images: [{ url: 'https://example.com/a.png', file: 'a.png' }]
    })
  })

  it('群消息只在明确 @ 机器人时标记 mentioned', async () => {
    const { socket, onMessage } = await readyClient({ selfId: '999' })
    socket.push({
      post_type: 'message',
      message_type: 'group',
      self_id: 999,
      group_id: 555,
      user_id: 10001,
      message_id: 88,
      message: [
        { type: 'at', data: { qq: '999' } },
        { type: 'text', data: { text: ' 在吗' } }
      ],
      sender: { nickname: '阿七', card: '小七' }
    })

    expect(onMessage.mock.calls[0]?.[0]).toMatchObject({
      chatType: 'group',
      peerId: '555',
      nickname: '小七',
      content: '在吗',
      mentioned: true
    })
  })

  it('没被 @ 的群消息也回调，但 mentioned 为 false，由宿主决定接不接', async () => {
    const { socket, onMessage } = await readyClient({ selfId: '999' })
    socket.push({
      post_type: 'message',
      message_type: 'group',
      self_id: 999,
      group_id: 555,
      user_id: 10001,
      message: [{ type: 'text', data: { text: '随便聊聊' } }]
    })
    expect(onMessage.mock.calls[0]?.[0]).toMatchObject({ mentioned: false })
  })

  it('自己的消息不回流', async () => {
    const { socket, onMessage } = await readyClient({ selfId: '999' })
    socket.push({
      post_type: 'message',
      message_type: 'private',
      self_id: 999,
      user_id: 999,
      message: '我自己'
    })
    expect(onMessage).not.toHaveBeenCalled()
  })

  it('主动发私聊不依赖入站消息', async () => {
    const { client, socket } = await readyClient({ selfId: '999' })
    const pending = client.sendPrivate('10001', ' 晚安 ')
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1))
    expect(socket.request(0)).toEqual({
      action: 'send_private_msg',
      params: { user_id: '10001', message: '晚安' },
      echo: expect.any(String)
    })
    socket.ack(0)
    await expect(pending).resolves.toBe(true)
  })

  it('协议端返回失败时发送结果为 false', async () => {
    const { client, socket } = await readyClient({ selfId: '999' })
    const pending = client.sendPrivate('10001', '在吗')
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1))
    const request = JSON.parse(socket.sent[0] ?? '{}') as { echo?: string }
    socket.push({ status: 'failed', retcode: 1200, echo: request.echo, wording: '风控' })
    await expect(pending).resolves.toBe(false)
  })

  it('正在输入走 set_input_status，未配置 selfId 时直接跳过', async () => {
    const { client, socket } = await readyClient({ selfId: '999' })
    const pending = client.setInputStatus('10001', true)
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1))
    expect(socket.request(0)).toMatchObject({
      action: 'set_input_status',
      params: { user_id: '10001', event_type: 1 }
    })
    socket.ack(0)
    await expect(pending).resolves.toBe(true)

    const withoutSelf = await readyClient()
    await expect(withoutSelf.client.setInputStatus('10001', true)).resolves.toBe(false)
    expect(withoutSelf.socket.sent).toHaveLength(0)
  })
})
