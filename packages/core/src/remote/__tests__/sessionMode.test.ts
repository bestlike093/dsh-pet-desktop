import { describe, expect, it } from 'vitest'
import { ALL_PERMISSIONS } from '@pet/shared'
import { PermissionBroker } from '../../modules/permissionBroker.js'
import { SessionModeGate, isSessionMode, permissionsForMode } from '../sessionMode.js'

const AT = new Date(2026, 9, 31, 22, 40, 0).getTime()

describe('permissionsForMode', () => {
  it('chat 只给最小集：渲染、面板、读记忆', () => {
    expect(permissionsForMode('chat')).toEqual(['ui.render', 'ui.panel', 'memory.read'])
  })

  it('closed-agent 给全部权限', () => {
    expect([...permissionsForMode('closed-agent')]).toEqual([...ALL_PERMISSIONS])
  })

  it('未知模式直接抛错，不回落到任何默认集', () => {
    expect(() => permissionsForMode('owner' as never)).toThrow(/未知会话模式/)
    expect(() => permissionsForMode('' as never)).toThrow(/未知会话模式/)
  })

  it('isSessionMode 只认已定义的两个值', () => {
    expect(isSessionMode('chat')).toBe(true)
    expect(isSessionMode('closed-agent')).toBe(true)
    expect(isSessionMode('reserved')).toBe(false)
  })
})

describe('SessionModeGate', () => {
  it('默认 chat，并且构造时就已下发权限', () => {
    const broker = new PermissionBroker()
    const gate = new SessionModeGate({ broker, now: () => AT })

    expect(gate.mode).toBe('chat')
    expect(broker.has('ui.render')).toBe(true)
    expect(broker.has('dsh.decision.commit')).toBe(false)
  })

  it('chat 下群友不能替主人拍板、不能写记忆、不能联网', () => {
    const gate = new SessionModeGate({ broker: new PermissionBroker(), now: () => AT })

    expect(gate.can('dsh.decision.commit')).toBe(false)
    expect(gate.can('memory.write')).toBe(false)
    expect(gate.can('net.egress')).toBe(false)
  })

  it('切到 closed-agent 后拿到完整权限', () => {
    const broker = new PermissionBroker()
    const gate = new SessionModeGate({ broker, now: () => AT })

    gate.switchTo('closed-agent')

    expect(gate.mode).toBe('closed-agent')
    expect([...broker.snapshot()].sort()).toEqual([...ALL_PERMISSIONS].sort())
    expect(gate.can('dsh.decision.commit')).toBe(true)
  })

  it('从 closed-agent 切回 chat 时多余权限会被收回', () => {
    const broker = new PermissionBroker()
    const gate = new SessionModeGate({ broker, initial: 'closed-agent', now: () => AT })

    expect(gate.can('dsh.decision.commit')).toBe(true)

    gate.switchTo('chat')

    expect(gate.can('dsh.decision.commit')).toBe(false)
    expect(gate.can('memory.write')).toBe(false)
    expect([...broker.snapshot()].sort()).toEqual(
      ['ui.render', 'ui.panel', 'memory.read'].sort()
    )
  })

  it('重复切换同一模式不产生审计项', () => {
    const gate = new SessionModeGate({ broker: new PermissionBroker(), now: () => AT })

    gate.switchTo('chat')
    gate.switchTo('chat')

    expect(gate.audit()).toHaveLength(1)
  })

  it('切换历史按时间顺序记录 from / to', () => {
    const gate = new SessionModeGate({ broker: new PermissionBroker(), now: () => AT })

    gate.switchTo('closed-agent')
    gate.switchTo('chat')

    expect(gate.audit()).toEqual([
      { from: null, to: 'chat', at: AT, reason: 'manual' },
      { from: 'chat', to: 'closed-agent', at: AT, reason: 'manual' },
      { from: 'closed-agent', to: 'chat', at: AT, reason: 'manual' }
    ])
  })

  it('switchTo 未知模式抛错，且不改动当前权限', () => {
    const broker = new PermissionBroker()
    const gate = new SessionModeGate({ broker, now: () => AT })

    expect(() => gate.switchTo('admin' as never)).toThrow(/未知会话模式/)
    expect(gate.mode).toBe('chat')
    expect(broker.has('dsh.decision.commit')).toBe(false)
  })

  it('snapshot 同时给出模式与当前权限', () => {
    const gate = new SessionModeGate({ broker: new PermissionBroker(), now: () => AT })

    expect(gate.snapshot()).toEqual({
      mode: 'chat',
      permissions: ['ui.render', 'ui.panel', 'memory.read']
    })
  })

  it('权限流动经过 broker 审计：降权记为 revoke', () => {
    const broker = new PermissionBroker()
    const gate = new SessionModeGate({ broker, initial: 'closed-agent', now: () => AT })

    gate.switchTo('chat')

    const revoked = broker.audit().filter((entry) => entry.action === 'revoke')
    expect(revoked.map((entry) => entry.permission)).toContain('dsh.decision.commit')
  })
})

describe('SessionModeGate 空闲降权', () => {
  it('未到窗口不降权', () => {
    let clock = AT
    const gate = new SessionModeGate({
      broker: new PermissionBroker(),
      initial: 'closed-agent',
      now: () => clock,
      idleTimeoutMs: 60_000
    })

    clock = AT + 59_000
    expect(gate.tick()).toBe(false)
    expect(gate.mode).toBe('closed-agent')
  })

  it('到点自动降回 chat，并收回提权', () => {
    let clock = AT
    const broker = new PermissionBroker()
    const gate = new SessionModeGate({
      broker,
      initial: 'closed-agent',
      now: () => clock,
      idleTimeoutMs: 60_000
    })

    clock = AT + 60_000
    expect(gate.tick()).toBe(true)
    expect(gate.mode).toBe('chat')
    expect(broker.has('dsh.decision.commit')).toBe(false)
    expect(broker.has('memory.write')).toBe(false)
  })

  it('touch 把空闲计时归零', () => {
    let clock = AT
    const gate = new SessionModeGate({
      broker: new PermissionBroker(),
      initial: 'closed-agent',
      now: () => clock,
      idleTimeoutMs: 60_000
    })

    clock = AT + 50_000
    gate.touch()
    clock = AT + 100_000
    expect(gate.tick()).toBe(false)
    expect(gate.mode).toBe('closed-agent')
  })

  it('chat 模式下 tick 不动作', () => {
    let clock = AT
    const gate = new SessionModeGate({
      broker: new PermissionBroker(),
      now: () => clock,
      idleTimeoutMs: 1
    })

    clock = AT + 10_000
    expect(gate.tick()).toBe(false)
    expect(gate.mode).toBe('chat')
  })

  it('idleTimeoutMs 为 0 时关闭自动降权', () => {
    let clock = AT
    const gate = new SessionModeGate({
      broker: new PermissionBroker(),
      initial: 'closed-agent',
      now: () => clock,
      idleTimeoutMs: 0
    })

    clock = AT + 86_400_000
    expect(gate.tick()).toBe(false)
    expect(gate.mode).toBe('closed-agent')
  })

  it('自动降权在审计里标 idle-timeout，与手动切换分开', () => {
    let clock = AT
    const gate = new SessionModeGate({
      broker: new PermissionBroker(),
      initial: 'closed-agent',
      now: () => clock,
      idleTimeoutMs: 60_000
    })

    clock = AT + 60_000
    gate.tick()

    const entries = gate.audit()
    expect(entries[entries.length - 1]).toMatchObject({
      from: 'closed-agent',
      to: 'chat',
      reason: 'idle-timeout'
    })
  })

  it('switchTo 会重置空闲计时', () => {
    let clock = AT
    const gate = new SessionModeGate({
      broker: new PermissionBroker(),
      now: () => clock,
      idleTimeoutMs: 60_000
    })

    gate.switchTo('closed-agent')
    clock = AT + 50_000
    expect(gate.tick()).toBe(false)
    expect(gate.mode).toBe('closed-agent')
  })

  it('onChange 收到切换事件，取消后不再收到', () => {
    const gate = new SessionModeGate({ broker: new PermissionBroker(), now: () => AT })
    const seen: string[] = []
    const off = gate.onChange((entry) => seen.push(`${entry.from}->${entry.to}`))

    gate.switchTo('closed-agent')
    off()
    gate.switchTo('chat')

    expect(seen).toEqual(['chat->closed-agent'])
  })

  it('idleMs 反映距上次活动的时间', () => {
    let clock = AT
    const gate = new SessionModeGate({ broker: new PermissionBroker(), now: () => clock })

    clock = AT + 12_345
    expect(gate.idleMs).toBe(12_345)
  })
})
