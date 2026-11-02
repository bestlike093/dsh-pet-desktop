import { describe, expect, it } from 'vitest'
import { PetStateMachine } from '../stateMachine.js'
import { ALL_ACTIVITIES, SleepGate } from '../sleepGate.js'

function sleepingMachine(): PetStateMachine {
  const machine = new PetStateMachine('idle')
  machine.transition('sleeping')
  return machine
}

describe('SleepGate', () => {
  it('醒着时全部放行', () => {
    const gate = new SleepGate({ machine: new PetStateMachine('idle') })
    expect(gate.sleeping).toBe(false)
    for (const activity of ALL_ACTIVITIES) {
      expect(gate.allows(activity)).toBe(true)
      expect(gate.request(activity)).toBe(true)
    }
    expect(gate.pending).toBe(0)
  })

  it('睡着时全部拦下', () => {
    const gate = new SleepGate({ machine: sleepingMachine() })
    expect(gate.sleeping).toBe(true)
    for (const activity of ALL_ACTIVITIES) {
      expect(gate.allows(activity)).toBe(false)
      expect(gate.request(activity)).toBe(false)
    }
    expect(gate.pending).toBe(ALL_ACTIVITIES.length)
  })

  it('睡眠时被拦的行为会被记下来', () => {
    let now = 1000
    const gate = new SleepGate({ machine: sleepingMachine(), now: () => now })

    gate.request('speak', '有人问在吗')
    now = 2000
    gate.request('notify')

    expect(gate.drain()).toEqual([
      { activity: 'speak', at: 1000, detail: '有人问在吗' },
      { activity: 'notify', at: 2000 }
    ])
  })

  it('drain 之后清空，不会重复补偿', () => {
    const gate = new SleepGate({ machine: sleepingMachine() })
    gate.request('speak')
    expect(gate.drain()).toHaveLength(1)
    expect(gate.drain()).toHaveLength(0)
    expect(gate.pending).toBe(0)
  })

  it('醒来后恢复放行', () => {
    const machine = sleepingMachine()
    const gate = new SleepGate({ machine })

    gate.request('speak')
    expect(gate.pending).toBe(1)

    machine.transition('idle')
    expect(gate.sleeping).toBe(false)
    expect(gate.request('speak')).toBe(true)
  })

  it('clear 只清账，不影响后续记录', () => {
    const gate = new SleepGate({ machine: sleepingMachine() })
    gate.request('speak')
    gate.clear()
    expect(gate.pending).toBe(0)

    gate.request('animate')
    expect(gate.pending).toBe(1)
  })

  it('超过上限时丢最早的，保留最近的', () => {
    const gate = new SleepGate({ machine: sleepingMachine(), maxSuppressed: 3 })

    for (const activity of ALL_ACTIVITIES) {
      gate.request(activity)
    }

    const drained = gate.drain()
    expect(drained).toHaveLength(3)
    expect(drained.map((entry) => entry.activity)).toEqual(['todo-remind', 'proactive', 'notify'])
  })

  it('上限至少为 1，传 0 也不会丢掉全部记录', () => {
    const gate = new SleepGate({ machine: sleepingMachine(), maxSuppressed: 0 })
    gate.request('speak')
    gate.request('animate')
    expect(gate.drain()).toHaveLength(1)
  })

  it('实时读取状态机，不缓存睡眠态', () => {
    const machine = new PetStateMachine('idle')
    const gate = new SleepGate({ machine })

    expect(gate.sleeping).toBe(false)
    machine.transition('sleeping')
    expect(gate.sleeping).toBe(true)
    machine.transition('idle')
    expect(gate.sleeping).toBe(false)
  })
})
