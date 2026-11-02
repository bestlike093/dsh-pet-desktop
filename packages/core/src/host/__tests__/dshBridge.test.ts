import { describe, expect, it } from 'vitest'
import type { HostCapability } from '@pet/shared'
import { DshBridge } from '../dshBridge.js'

const host = {
  version: '1.0.0',
  ask: async () => ({ id: 'ask-1', answer: 'yes', source: 'pet' as const })
}

describe('DshBridge：能力按真实声明判定', () => {
  it('没有快照时 settings / tray / window 不乐观放行', () => {
    const bridge = DshBridge.connect(host)

    expect(bridge.isAvailable('ask')).toBe(true)
    expect(bridge.isAvailable('settings')).toBe(false)
    expect(bridge.isAvailable('tray')).toBe(false)
    expect(bridge.isAvailable('window')).toBe(false)
  })

  it('快照声明后才为 true，且不越过宿主实际方法', () => {
    const bridge = DshBridge.connect(host, {
      version: '1.0.0',
      available: ['settings', 'tray', 'window'] as const satisfies readonly HostCapability[]
    })

    expect(bridge.isAvailable('settings')).toBe(true)
    expect(bridge.isAvailable('tray')).toBe(true)
    expect(bridge.isAvailable('window')).toBe(true)
    // 快照没声明 ask，即使宿主对象上有 ask 方法也不放行。
    expect(bridge.isAvailable('ask')).toBe(false)
  })
})
