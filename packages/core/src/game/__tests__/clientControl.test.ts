import { describe, expect, it } from 'vitest'
import {
  ARMING_WARNINGS,
  CLIENT_OPERATIONS,
  ClientControl,
  ClientControlDisabledError,
  DEFAULT_REQUIRED_WARNINGS,
  MIN_REQUIRED_WARNINGS
} from '../clientControl'

const T = 1_000_000
const GAP = 20_000

function armedControl(options: { armDurationMs?: number; requiredWarnings?: number } = {}): ClientControl {
  const control = new ClientControl(options)
  for (let i = 0; i < DEFAULT_REQUIRED_WARNINGS; i += 1) {
    control.requestArm(T + i * GAP)
  }
  return control
}

describe('游戏客户端操作：默认不可用', () => {
  it('新实例是 disabled', () => {
    const control = new ClientControl()
    expect(control.stateOf(T)).toBe('disabled')
  })

  it('默认状态下连抓帧都拒绝', () => {
    const control = new ClientControl()
    for (const operation of CLIENT_OPERATIONS) {
      expect(() => control.assertAllowed(operation, T)).toThrow(ClientControlDisabledError)
    }
  })
})

describe('游戏客户端操作：警告阶梯', () => {
  it('第一次请求只给警告，不会开启', () => {
    const control = new ClientControl()
    const decision = control.requestArm(T)

    expect(decision.armed).toBe(false)
    expect(decision.state).toBe('warning')
    expect(decision.warning).toBeDefined()
    expect(decision.remaining).toBe(DEFAULT_REQUIRED_WARNINGS - 1)
  })

  it('警告文案一次比一次重，三次各不相同', () => {
    const control = new ClientControl()
    const seen = new Set<string>()

    for (let i = 0; i < DEFAULT_REQUIRED_WARNINGS; i += 1) {
      const decision = control.requestArm(T + i * GAP)
      if (decision.warning !== undefined) seen.add(decision.warning)
    }

    expect(seen.size).toBe(DEFAULT_REQUIRED_WARNINGS)
    expect(ARMING_WARNINGS.length).toBeGreaterThanOrEqual(DEFAULT_REQUIRED_WARNINGS)
  })

  it('冷却期内重复请求不算次数', () => {
    const control = new ClientControl()
    control.requestArm(T)
    const second = control.requestArm(T + 1_000)

    expect(second.warning).toBeUndefined()
    expect(second.remaining).toBe(DEFAULT_REQUIRED_WARNINGS - 1)
    expect(control.status(T).warningsGiven).toBe(1)
  })

  it('走完三次警告才真正开启', () => {
    const control = new ClientControl()
    expect(control.requestArm(T).armed).toBe(false)
    expect(control.requestArm(T + GAP).armed).toBe(false)
    expect(control.requestArm(T + GAP * 2).armed).toBe(true)
    expect(control.isArmed(T + GAP * 2)).toBe(true)
  })

  it('警告次数下限是 3，配置写 1 会被钳回去', () => {
    const control = new ClientControl({ requiredWarnings: 1 })
    expect(control.requiredWarnings).toBe(MIN_REQUIRED_WARNINGS)

    expect(control.requestArm(T).armed).toBe(false)
    expect(control.requestArm(T + GAP).armed).toBe(false)
    expect(control.requestArm(T + GAP * 2).armed).toBe(true)
  })
})

describe('游戏客户端操作：开启之后', () => {
  it('四个操作全部放行', () => {
    const control = armedControl()
    for (const operation of CLIENT_OPERATIONS) {
      expect(() => control.assertAllowed(operation, T + GAP * 3)).not.toThrow()
    }
  })

  it('未知操作即使在 armed 状态也拒绝', () => {
    const control = armedControl()
    expect(() => control.assertAllowed('delete-save', T + GAP * 3)).toThrow(
      ClientControlDisabledError
    )
  })

  it('已 armed 时再请求开启，不会重置时限', () => {
    const control = armedControl()
    const now = T + GAP * 3
    const before = control.status(now).armedUntil
    control.requestArm(now)
    expect(control.status(now).armedUntil).toBe(before)
  })
})

describe('游戏客户端操作：收回', () => {
  it('到期自动回落，不靠谁记得去关', () => {
    const control = armedControl({ armDurationMs: 60_000 })
    // 第三次警告在 T + 2×GAP 触发武装，不是 3×GAP。
    const armedAt = T + GAP * 2

    expect(control.isArmed(armedAt)).toBe(true)
    expect(control.isArmed(armedAt + 59_999)).toBe(true)
    expect(control.isArmed(armedAt + 60_000)).toBe(false)
    expect(control.stateOf(armedAt + 60_000)).toBe('disabled')
  })

  it('到期后操作重新被拒', () => {
    const control = armedControl({ armDurationMs: 60_000 })
    const expired = T + GAP * 2 + 60_000
    expect(() => control.assertAllowed('click', expired)).toThrow(ClientControlDisabledError)
  })

  it('手动停下立即回落，并清空累积的警告', () => {
    const control = armedControl()
    control.disarm()

    expect(control.stateOf(T + GAP * 3)).toBe('disabled')
    expect(control.status(T + GAP * 3).warningsGiven).toBe(0)
  })

  it('停下之后要重新走完三次警告', () => {
    const control = armedControl()
    control.disarm()

    expect(control.requestArm(T + GAP * 4).armed).toBe(false)
    expect(control.requestArm(T + GAP * 5).armed).toBe(false)
    expect(control.requestArm(T + GAP * 6).armed).toBe(true)
  })
})

describe('游戏客户端操作：状态视图', () => {
  it('disabled 时没有 armedUntil', () => {
    const status = new ClientControl().status(T)
    expect(status.state).toBe('disabled')
    expect(status.armedUntil).toBeUndefined()
    expect(status.requiredWarnings).toBe(DEFAULT_REQUIRED_WARNINGS)
  })

  it('warning 阶段能看到还差几次', () => {
    const control = new ClientControl()
    control.requestArm(T)
    const status = control.status(T)

    expect(status.state).toBe('warning')
    expect(status.warningsGiven).toBe(1)
    expect(status.requiredWarnings - status.warningsGiven).toBe(2)
  })

  it('armed 时带到期时间', () => {
    const control = armedControl({ armDurationMs: 60_000 })
    const status = control.status(T + GAP * 3)
    expect(status.state).toBe('armed')
    expect(status.armedUntil).toBe(T + GAP * 2 + 60_000)
  })
})
