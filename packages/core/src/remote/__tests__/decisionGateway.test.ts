import { describe, expect, it } from 'vitest'
import type {
  ChannelCapabilities,
  ChannelSendResult,
  DecisionEnvelope,
  DecisionReply,
  DiagResult,
  IChannelAdapter
} from '@pet/shared'
import { DecisionGateway } from '../decisionGateway.js'
import type { DecisionGatewayOptions } from '../decisionGateway.js'

class FakeChannel implements IChannelAdapter {
  private readonly handlers = new Set<(reply: DecisionReply) => void>()

  constructor(readonly id: string) {}

  capabilities(): ChannelCapabilities {
    return { approval: true, question: true, richCard: false, memorySync: false }
  }

  async send(envelope: DecisionEnvelope): Promise<ChannelSendResult> {
    return { messageId: envelope.id }
  }

  onReply(handler: (reply: DecisionReply) => void): () => void {
    this.handlers.add(handler)
    return () => {
      this.handlers.delete(handler)
    }
  }

  async health(): Promise<DiagResult> {
    return { ok: true, message: 'fake' }
  }

  emit(reply: DecisionReply): void {
    for (const handler of this.handlers) handler(reply)
  }
}

async function ask(
  channel: FakeChannel,
  options: Omit<DecisionGatewayOptions, 'deviceId' | 'channels'> = {}
): Promise<{ gateway: DecisionGateway; envelope: DecisionEnvelope }> {
  const gateway = new DecisionGateway({
    deviceId: 'test',
    channels: [channel],
    timeoutMs: 20,
    ...options
  })
  const envelope = await gateway.prepare({ kind: 'approval', summary: '测试' })
  return { gateway, envelope }
}

function reply(envelopeId: string, sender?: DecisionReply['sender']): DecisionReply {
  return {
    envelopeId,
    action: 'allow',
    decidedAt: 1,
    sig: '',
    ...(sender === undefined ? {} : { sender })
  }
}

describe('DecisionGateway：远程回复鉴权', () => {
  it('远程通道缺 sender 时按超时处理，不采信匿名回复', async () => {
    const channel = new FakeChannel('qq')
    const { gateway, envelope } = await ask(channel)

    channel.emit(reply(envelope.id))

    expect((await gateway.wait(envelope.id)).status).toBe('timeout')
    gateway.dispose()
  })

  it('sender.channelId 与订阅通道不一致时拒绝', async () => {
    const channel = new FakeChannel('qq')
    const { gateway, envelope } = await ask(channel)

    channel.emit(reply(envelope.id, { channelId: 'other', id: 'owner', chatType: 'private' }))

    expect((await gateway.wait(envelope.id)).status).toBe('timeout')
    gateway.dispose()
  })

  it('未配置 authorizeReply 时拒绝带 sender 的回复', async () => {
    const channel = new FakeChannel('qq')
    const { gateway, envelope } = await ask(channel)

    channel.emit(reply(envelope.id, { channelId: 'qq', id: 'owner', chatType: 'private' }))

    expect((await gateway.wait(envelope.id)).status).toBe('timeout')
    gateway.dispose()
  })

  it('authorizeReply 放行后正常结算，并拿到 envelope 与通道 id', async () => {
    const channel = new FakeChannel('qq')
    const seen: string[] = []
    const { gateway, envelope } = await ask(channel, {
      authorizeReply: (item, itemEnvelope, channelId) => {
        seen.push(`${channelId}:${item.envelopeId}:${itemEnvelope.id}`)
        return true
      }
    })

    channel.emit(reply(envelope.id, { channelId: 'qq', id: 'owner', chatType: 'private' }))

    const outcome = await gateway.wait(envelope.id)
    expect(outcome.status).toBe('allowed')
    expect(seen).toEqual([`qq:${envelope.id}:${envelope.id}`])
    gateway.dispose()
  })

  it('authorizeReply 抛错按拒绝处理', async () => {
    const channel = new FakeChannel('qq')
    const { gateway, envelope } = await ask(channel, {
      authorizeReply: () => {
        throw new Error('boom')
      }
    })

    channel.emit(reply(envelope.id, { channelId: 'qq', id: 'owner', chatType: 'private' }))

    expect((await gateway.wait(envelope.id)).status).toBe('timeout')
    gateway.dispose()
  })

  it('本机回环不带 sender 仍然可用', async () => {
    const channel = new FakeChannel('local-loopback')
    const { gateway, envelope } = await ask(channel)

    channel.emit(reply(envelope.id))

    expect((await gateway.wait(envelope.id)).status).toBe('allowed')
    gateway.dispose()
  })
})
