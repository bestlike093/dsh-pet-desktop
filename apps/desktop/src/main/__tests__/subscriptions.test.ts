import { describe, expect, it, vi } from 'vitest'
import { SubscriptionRegistry } from '../ipc/lib/subscriptions.js'

describe('SubscriptionRegistry', () => {
  it('销毁只摘自己那条，不误伤同窗口其他订阅', () => {
    const registry = new SubscriptionRegistry()
    const first = vi.fn()
    const second = vi.fn()
    registry.add(3, first)
    registry.add(3, second)

    registry.remove(3, first)
    expect(registry.size(3)).toBe(1)

    registry.dispose(3)
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('重建后旧 id 无订阅，新 id 只有一条', () => {
    const registry = new SubscriptionRegistry()
    const oldDispose = vi.fn()
    registry.add(7, oldDispose)
    registry.dispose(7)

    expect(registry.has(7)).toBe(false)
    expect(oldDispose).toHaveBeenCalledTimes(1)

    registry.add(8, () => {})
    expect(registry.has(8)).toBe(true)
    expect(registry.size(8)).toBe(1)
  })

  it('destroyed 回调里先 delete 再放行，最后一帧查不到旧 id', () => {
    const registry = new SubscriptionRegistry()
    let seenDuringDispose: boolean | null = null
    registry.add(7, () => {
      seenDuringDispose = registry.has(7)
    })

    registry.dispose(7)
    expect(seenDuringDispose).toBe(false)
  })

  it('dispose 不存在的 sender 是 no-op，不抛', () => {
    const registry = new SubscriptionRegistry()
    expect(() => registry.dispose(404)).not.toThrow()
    expect(registry.has(404)).toBe(false)
  })

  it('同 sender 两个会话，关一个留一个，窗口销毁才全清', () => {
    const registry = new SubscriptionRegistry()
    const first = vi.fn()
    const second = vi.fn()
    registry.addConversation(7, 'conv-a', first)
    registry.addConversation(7, 'conv-b', second)

    registry.dispose(7, 'conv-a')
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).not.toHaveBeenCalled()
    expect(registry.has(7)).toBe(true)
    expect(registry.has(7, 'conv-a')).toBe(false)
    expect(registry.size(7, 'conv-b')).toBe(1)

    registry.dispose(7)
    expect(second).toHaveBeenCalledTimes(1)
    expect(registry.has(7)).toBe(false)
  })

  it('坏一个不影响其余，错误聚合后抛出', () => {
    const registry = new SubscriptionRegistry()
    const good = vi.fn()
    registry.add(9, () => {
      throw new Error('bad listener')
    })
    registry.add(9, good)

    let caught: unknown = null
    try {
      registry.dispose(9)
    } catch (error) {
      caught = error
    }

    expect(good).toHaveBeenCalledTimes(1)
    expect(registry.has(9)).toBe(false)
    expect(caught).toBeInstanceOf(AggregateError)
    expect((caught as AggregateError).errors).toHaveLength(1)
  })
})
