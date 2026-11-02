import { describe, expect, it } from 'vitest'
import { PermissionBroker } from '../../modules/permissionBroker.js'
import { OwnerPolicy, applyIncomingMessage } from '../ownerPolicy.js'
import { SessionModeGate } from '../sessionMode.js'

const AT = new Date(2026, 9, 31, 22, 40, 0).getTime()
const OWNER = '10001'

describe('OwnerPolicy', () => {
  it('私聊且 QQ 号在名单里才算主人', () => {
    const policy = new OwnerPolicy([OWNER])
    expect(policy.isOwner({ userId: OWNER, chatType: 'private' })).toBe(true)
  })

  it('私聊但不在名单里不算', () => {
    const policy = new OwnerPolicy([OWNER])
    expect(policy.isOwner({ userId: '20002', chatType: 'private' })).toBe(false)
  })

  it('群里即使 QQ 号对得上也不算', () => {
    const policy = new OwnerPolicy([OWNER])
    expect(policy.isOwner({ userId: OWNER, chatType: 'group' })).toBe(false)
  })

  it('名单为空时谁都不是主人', () => {
    const policy = new OwnerPolicy()
    expect(policy.isOwner({ userId: OWNER, chatType: 'private' })).toBe(false)
    expect(policy.ownerCount).toBe(0)
  })

  it('名单里的空串和空白项会被忽略', () => {
    const policy = new OwnerPolicy(['', '  ', OWNER])
    expect(policy.ownerCount).toBe(1)
    expect(policy.isOwner({ userId: '', chatType: 'private' })).toBe(false)
  })

  it('userId 两侧空格不影响判定', () => {
    const policy = new OwnerPolicy([OWNER])
    expect(policy.isOwner({ userId: ` ${OWNER} `, chatType: 'private' })).toBe(true)
  })
})

describe('applyIncomingMessage', () => {
  function setup(owners: readonly string[] = [OWNER]) {
    const broker = new PermissionBroker()
    let clock = AT
    const gate = new SessionModeGate({
      broker,
      now: () => clock,
      idleTimeoutMs: 60_000
    })
    return {
      broker,
      gate,
      policy: new OwnerPolicy(owners),
      advance: (ms: number) => {
        clock += ms
      }
    }
  }

  it('主人私聊把模式提到 closed-agent', () => {
    const { gate, policy } = setup()

    expect(applyIncomingMessage(gate, policy, { userId: OWNER, chatType: 'private' })).toBe(true)
    expect(gate.mode).toBe('closed-agent')
  })

  it('非主人消息不动模式', () => {
    const { gate, policy } = setup()

    expect(applyIncomingMessage(gate, policy, { userId: '20002', chatType: 'private' })).toBe(false)
    expect(gate.mode).toBe('chat')
  })

  it('主人在群里说话不提权', () => {
    const { gate, policy } = setup()

    applyIncomingMessage(gate, policy, { userId: OWNER, chatType: 'group' })

    expect(gate.mode).toBe('chat')
    expect(gate.can('dsh.decision.commit')).toBe(false)
  })

  it('已经是 closed-agent 时返回 false，不重复记审计', () => {
    const { gate, policy } = setup()

    applyIncomingMessage(gate, policy, { userId: OWNER, chatType: 'private' })
    const before = gate.audit().length
    const changed = applyIncomingMessage(gate, policy, { userId: OWNER, chatType: 'private' })

    expect(changed).toBe(false)
    expect(gate.audit()).toHaveLength(before)
  })

  it('主人连续说话会刷新空闲计时，不会被降权', () => {
    const { gate, policy, advance } = setup()

    applyIncomingMessage(gate, policy, { userId: OWNER, chatType: 'private' })
    advance(50_000)
    applyIncomingMessage(gate, policy, { userId: OWNER, chatType: 'private' })
    advance(30_000)

    expect(gate.tick()).toBe(false)
    expect(gate.mode).toBe('closed-agent')
  })

  it('群友说话不会刷新计时，也不会把主人踢下去', () => {
    const { gate, policy, advance } = setup()

    applyIncomingMessage(gate, policy, { userId: OWNER, chatType: 'private' })
    advance(50_000)
    applyIncomingMessage(gate, policy, { userId: '20002', chatType: 'group' })

    expect(gate.mode).toBe('closed-agent')

    advance(10_000)
    expect(gate.tick()).toBe(true)
    expect(gate.mode).toBe('chat')
  })
})
