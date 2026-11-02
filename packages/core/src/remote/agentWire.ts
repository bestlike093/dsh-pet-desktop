import type { SessionMode, SessionModeGate } from './sessionMode.js'
import { applyIncomingMessage } from './ownerPolicy.js'
import type { IncomingMessage, OwnerPolicy } from './ownerPolicy.js'

/**
 * 消息装配点。
 *
 * 把「谁在说话 → 她此刻能做什么 → 她说什么 → 发回去」串成一条链。
 * 这一层只做编排：不碰网络、不碰 dsh、不自己起定时器。
 * 谁把消息喂进来、谁把回复送出去，都由调用方决定。
 */

export interface WireMessage extends IncomingMessage {
  readonly text: string
  readonly at: number
}

export interface AgentTurn {
  readonly mode: SessionMode
  readonly text: string
  readonly isOwner: boolean
}

export interface AgentReply {
  readonly text: string
}

/** 跑一轮 agent。由宿主实现，core 只约定形状。 */
export interface AgentRunner {
  run(turn: AgentTurn): Promise<AgentReply>
}

export interface AgentWireOptions {
  readonly gate: SessionModeGate
  readonly policy: OwnerPolicy
  readonly runner: AgentRunner
  /** 把回复送回来源通道。 */
  readonly reply: (text: string) => Promise<void>
  /**
   * agent 失败时给用户看的话。
   * 默认不暴露内部错误：把堆栈甩进群里既不安全也没用。
   */
  readonly onError?: (error: unknown, message: WireMessage) => string
}

export const DEFAULT_ERROR_REPLY = '刚刚没想明白，等下再试一次好不好？'

export class AgentWire {
  private readonly gate: SessionModeGate
  private readonly policy: OwnerPolicy
  private readonly runner: AgentRunner
  private readonly reply: (text: string) => Promise<void>
  private readonly onError: (error: unknown, message: WireMessage) => string

  constructor(options: AgentWireOptions) {
    this.gate = options.gate
    this.policy = options.policy
    this.runner = options.runner
    this.reply = options.reply
    this.onError = options.onError ?? (() => DEFAULT_ERROR_REPLY)
  }

  /**
   * 处理一条消息。
   *
   * 顺序是刻意的：先按身份提权，再检查空闲降权。
   * 反过来的话，主人隔了五分钟开口，会先被降权再提权，
   * 中途那一瞬间的工具面是错的，而且审计里会多出一条假的切换。
   */
  async handle(message: WireMessage): Promise<AgentReply> {
    applyIncomingMessage(this.gate, this.policy, message)
    this.gate.tick()

    const isOwner = this.policy.isOwner(message)

    let reply: AgentReply
    try {
      reply = await this.runner.run({
        mode: this.gate.mode,
        text: message.text,
        isOwner
      })
    } catch (error) {
      reply = { text: this.onError(error, message) }
    }

    await this.reply(reply.text)
    return reply
  }

  /** 宿主定时调用，只做空闲降权。返回 true 表示这一轮收权了。 */
  tick(now?: number): boolean {
    return this.gate.tick(now)
  }
}
