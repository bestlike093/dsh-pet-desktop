import { describe, expect, it } from 'vitest'
import { PermissionBroker } from '../../modules/permissionBroker.js'
import { SessionModeGate } from '../sessionMode.js'
import { OwnerPolicy } from '../ownerPolicy.js'
import { AgentWire, DEFAULT_ERROR_REPLY } from '../agentWire.js'
import type { AgentTurn } from '../agentWire.js'

const AT = new Date(2026, 9, 31, 22, 40, 0).getTime()
const MINUTE = 60_000

function setup(options: { fail?: boolean; onError?: (error: unknown) => string } = {}) {
  const broker = new PermissionBroker()
  const gate = new SessionModeGate({ broker, now: () => AT })
  const policy = new OwnerPolicy(['10001'])
  const turns: AgentTurn[] = []
  const replies: string[] = []

  const wire = new AgentWire({
    gate,
    policy,
    runner: {
      async run(turn) {
        turns.push(turn)
        if (options.fail === true) throw new Error('模型超时')
        return { text: `收到：${turn.text}` }
      }
    },
    reply: async (text) => {
      replies.push(text)
    },
    ...(options.onError === undefined ? {} : { onError: (error) => options.onError?.(error) ?? '' })
  })

  return { wire, gate, broker, turns, replies }
}

describe('AgentWire', () => {
  it('主人私聊会提权，runner 拿到 closed-agent', async () => {
    const { wire, turns, gate } = setup()
    await wire.handle({ userId: '10001', chatType: 'private', text: '在吗', at: AT })

    expect(gate.mode).toBe('closed-agent')
    expect(turns[0]?.mode).toBe('closed-agent')
    expect(turns[0]?.isOwner).toBe(true)
  })

  it('群友消息保持 chat，不拿主人权限', async () => {
    const { wire, turns, gate } = setup()
    await wire.handle({ userId: '20002', chatType: 'group', text: '你好', at: AT })

    expect(gate.mode).toBe('chat')
    expect(turns[0]?.mode).toBe('chat')
    expect(turns[0]?.isOwner).toBe(false)
  })

  it('把回复送回通道', async () => {
    const { wire, replies } = setup()
    const result = await wire.handle({
      userId: '10001',
      chatType: 'private',
      text: '晚上好',
      at: AT
    })

    expect(result.text).toBe('收到：晚上好')
    expect(replies).toEqual(['收到：晚上好'])
  })

  it('runner 抛错时不把异常甩出去，回一句人话', async () => {
    const { wire, replies } = setup({ fail: true })
    const result = await wire.handle({
      userId: '10001',
      chatType: 'private',
      text: '帮我看看',
      at: AT
    })

    expect(result.text).toBe(DEFAULT_ERROR_REPLY)
    expect(replies[0]).toBe(DEFAULT_ERROR_REPLY)
  })

  it('可以自定义错误文案', async () => {
    const { wire } = setup({ fail: true, onError: () => '稍等一下，我这边有点卡' })
    const result = await wire.handle({
      userId: '10001',
      chatType: 'private',
      text: 'x',
      at: AT
    })
    expect(result.text).toBe('稍等一下，我这边有点卡')
  })

  it('提权后空闲超时，下一条群友消息会触发降权', async () => {
    const broker = new PermissionBroker()
    let now = AT
    const gate = new SessionModeGate({
      broker,
      now: () => now,
      idleTimeoutMs: 5 * MINUTE
    })
    const policy = new OwnerPolicy(['10001'])

    const wire = new AgentWire({
      gate,
      policy,
      runner: { run: async () => ({ text: 'ok' }) },
      reply: async () => {}
    })

    await wire.handle({ userId: '10001', chatType: 'private', text: '在吗', at: now })
    expect(gate.mode).toBe('closed-agent')

    now = AT + 6 * MINUTE
    await wire.handle({ userId: '20002', chatType: 'group', text: '路过', at: now })

    expect(gate.mode).toBe('chat')
    expect(broker.has('dsh.decision.commit')).toBe(false)
  })

  it('主人隔很久开口，先提权再判空闲，不会被自己降权', async () => {
    const broker = new PermissionBroker()
    let now = AT
    const gate = new SessionModeGate({
      broker,
      now: () => now,
      idleTimeoutMs: 5 * MINUTE
    })
    const policy = new OwnerPolicy(['10001'])
    const seen: string[] = []

    const wire = new AgentWire({
      gate,
      policy,
      runner: {
        async run(turn) {
          seen.push(turn.mode)
          return { text: 'ok' }
        }
      },
      reply: async () => {}
    })

    await wire.handle({ userId: '10001', chatType: 'private', text: '第一次', at: now })
    now = AT + 30 * MINUTE
    await wire.handle({ userId: '10001', chatType: 'private', text: '三十分钟后', at: now })

    expect(seen).toEqual(['closed-agent', 'closed-agent'])
    expect(gate.mode).toBe('closed-agent')
  })

  it('tick 可以单独由宿主驱动', () => {
    const broker = new PermissionBroker()
    let now = AT
    const gate = new SessionModeGate({ broker, now: () => now, idleTimeoutMs: MINUTE })
    const wire = new AgentWire({
      gate,
      policy: new OwnerPolicy(['10001']),
      runner: { run: async () => ({ text: 'ok' }) },
      reply: async () => {}
    })

    gate.switchTo('closed-agent')
    now = AT + 2 * MINUTE
    expect(wire.tick()).toBe(true)
    expect(gate.mode).toBe('chat')
  })
})
