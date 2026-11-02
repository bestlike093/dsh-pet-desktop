import { describe, expect, it, vi } from 'vitest'
import type {
  IPresentationSubscriberV1,
  TokenPatchV1,
  ValidationResultV1
} from '@pet/shared'
import { PresentationBus } from '../bus.js'
import { PresentationPortBase } from '../portBase.js'

interface DemoConfig {
  readonly id: string
  readonly color: string
}

class DemoPort extends PresentationPortBase<DemoConfig> {
  protected toPatch(value: DemoConfig): TokenPatchV1 {
    return { 'colors.primary': value.color }
  }

  validate(value: DemoConfig): ValidationResultV1 {
    return value.color.startsWith('#')
      ? { ok: true }
      : { ok: false, errors: [{ field: 'colors.primary', reason: 'INVALID_COLOR' }] }
  }

  describeTokens(): readonly string[] {
    return ['colors.primary']
  }
}

function spyPublisher() {
  return { publish: vi.fn(async (_patch: TokenPatchV1) => {}) }
}

describe('S7-b push 调用链', () => {
  it('apply 后 publish 恰好 1 次', async () => {
    const publisher = spyPublisher()
    const port = new DemoPort(publisher)

    await port.apply({ id: 'a', color: '#ff88cc' })

    expect(publisher.publish).toHaveBeenCalledTimes(1)
    expect(publisher.publish).toHaveBeenCalledWith({ 'colors.primary': '#ff88cc' })
  })

  it('broadcast 转调 publish，恰好 1 次且载荷为全量', async () => {
    const publisher = spyPublisher()
    const port = new DemoPort(publisher)
    await port.apply({ id: 'a', color: '#ff88cc' })
    publisher.publish.mockClear()

    await port.broadcast()

    expect(publisher.publish).toHaveBeenCalledTimes(1)
    expect(publisher.publish).toHaveBeenCalledWith({ 'colors.primary': '#ff88cc' })
  })

  it('apply 非法值抛错且一次都不推送', async () => {
    const publisher = spyPublisher()
    const port = new DemoPort(publisher)

    await expect(port.apply({ id: 'a', color: 'red' })).rejects.toThrow()
    expect(publisher.publish).toHaveBeenCalledTimes(0)
  })

  it('未 apply 时 broadcast 抛 NOT_REGISTERED', async () => {
    const publisher = spyPublisher()
    const port = new DemoPort(publisher)

    await expect(port.broadcast()).rejects.toThrow(/NOT_REGISTERED|尚未应用/)
  })
})

describe('S7-b 订阅端', () => {
  it('subscribe 返回的取消函数能摘掉监听器', async () => {
    const bus = new PresentationBus()
    const received: TokenPatchV1[] = []
    const unsubscribe = bus.subscribe((patch) => received.push(patch))

    await bus.publish({ 'colors.primary': '#111111' })
    unsubscribe()
    await bus.publish({ 'colors.primary': '#222222' })

    expect(received).toHaveLength(1)
    expect(bus.listenerCount()).toBe(0)
  })

  it('子窗类型没有上行入口', () => {
    const bus = new PresentationBus()
    const subscriber: IPresentationSubscriberV1 = bus

    if (false) {
      // @ts-expect-error 子窗不应拿到 publish —— 上行能力在类型层就不存在
      subscriber.publish({ 'colors.primary': '#000000' })
    }
  })
})
