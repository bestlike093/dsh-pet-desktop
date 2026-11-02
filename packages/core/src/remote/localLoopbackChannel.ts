import type {
  ChannelCapabilities,
  ChannelSendResult,
  DecisionAction,
  DecisionEnvelope,
  DecisionReply,
  DiagResult,
  IChannelAdapter
} from '@pet/shared'

/** 本地回环：不联网，用于桌面弹窗与端到端测试。 */
export class LocalLoopbackChannel implements IChannelAdapter {
  readonly id = 'local-loopback'
  private readonly handlers = new Set<(reply: DecisionReply) => void>()
  private readonly sent: DecisionEnvelope[] = []
  private readonly now: () => number

  constructor(now: () => number = Date.now) {
    this.now = now
  }

  capabilities(): ChannelCapabilities {
    return { approval: true, question: true, richCard: false, memorySync: false }
  }

  async send(envelope: DecisionEnvelope): Promise<ChannelSendResult> {
    this.sent.push(envelope)
    return { messageId: envelope.id }
  }

  onReply(handler: (reply: DecisionReply) => void): () => void {
    this.handlers.add(handler)
    return () => {
      this.handlers.delete(handler)
    }
  }

  /** 测试或本地 UI 用：模拟用户按下按钮。 */
  reply(envelopeId: string, action: DecisionAction, answer?: string): void {
    const reply: DecisionReply = {
      envelopeId,
      action,
      decidedAt: this.now(),
      sig: '',
      ...(answer === undefined ? {} : { answer })
    }
    for (const handler of this.handlers) handler(reply)
  }

  get sentCount(): number {
    return this.sent.length
  }

  lastSent(): DecisionEnvelope | undefined {
    return this.sent.at(-1)
  }

  async health(): Promise<DiagResult> {
    return { ok: true, message: '本地回环可用' }
  }
}
