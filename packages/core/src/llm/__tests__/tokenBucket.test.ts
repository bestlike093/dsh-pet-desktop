import { describe, expect, it } from 'vitest'
import { TokenBucket, TokenBucketRegistry } from '../tokenBucket.js'

describe('TokenBucket：按 provider 一个桶（S5）', () => {
  it('并发 tryConsume ×N 超过余量：只有余量允许的成功', async () => {
    const bucket = new TokenBucket('provider-a', {
      capacity: 5,
      refillPerMs: 0,
      initialTokens: 5
    })

    const results = await Promise.all(
      Array.from({ length: 20 }, () => Promise.resolve().then(() => bucket.tryConsume(1)))
    )

    expect(results.filter((result) => result.ok)).toHaveLength(5)
    expect(results.filter((result) => !result.ok)).toHaveLength(15)
    expect(bucket.snapshot().tokens).toBe(0)
  })

  it('时钟倒退时 tokens 不减、不抛错', () => {
    let clock = 1000
    const bucket = new TokenBucket('provider-a', {
      capacity: 10,
      refillPerMs: 0.01,
      initialTokens: 5,
      now: () => clock
    })

    clock = 2000
    const filled = bucket.snapshot().tokens
    expect(filled).toBe(10)

    clock = 1500
    const afterRewind = bucket.snapshot().tokens
    expect(afterRewind).toBe(10)
    expect(() => bucket.tryConsume(1)).not.toThrow()
  })

  it('n > capacity 显式返回 exceeds-capacity，不混成 insufficient', () => {
    const bucket = new TokenBucket('provider-a', {
      capacity: 10,
      refillPerMs: 0,
      initialTokens: 10
    })

    const result = bucket.tryConsume(11)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('exceeds-capacity')
    }
  })

  it('预扣 + 退款 10 次后桶未枯竭', () => {
    const bucket = new TokenBucket('provider-a', {
      capacity: 1000,
      refillPerMs: 0,
      initialTokens: 1000
    })

    for (let index = 0; index < 10; index += 1) {
      const reserved = bucket.tryConsume(100)
      expect(reserved.ok).toBe(true)
      bucket.refund(95)
    }

    expect(bucket.snapshot().tokens).toBe(950)
  })

  it('负数 refund 补扣实际用量，下限钳到 0', () => {
    const bucket = new TokenBucket('provider-a', {
      capacity: 100,
      refillPerMs: 0,
      initialTokens: 100
    })

    expect(bucket.refund(-30)).toBe(70)
    expect(bucket.refund(-1000)).toBe(0)
  })

  it('持久化恢复按经过时长折算，不重置满桶', () => {
    let wall = 0
    const options = {
      capacity: 100,
      refillPerMs: 0.001,
      initialTokens: 0,
      wallNow: () => wall,
      now: () => 0
    }

    const bucket = new TokenBucket('provider-a', options)
    wall = 10_000

    const restored = TokenBucket.restore('provider-a', options, bucket.serialize())

    expect(restored.snapshot().tokens).toBeCloseTo(10, 1)
    expect(restored.snapshot().tokens).toBeLessThan(restored.capacity)
  })

  it('切换 provider 不重置原桶', () => {
    const registry = new TokenBucketRegistry({
      capacity: 2,
      refillPerMs: 0,
      initialTokens: 2
    })

    const first = registry.get('provider-a')
    first.tryConsume(2)
    expect(first.snapshot().tokens).toBe(0)

    registry.get('provider-b')
    const again = registry.get('provider-a')

    expect(again).toBe(first)
    expect(again.snapshot().tokens).toBe(0)
  })

  it('诊断快照暴露 capacity / tokens / lastRefill / providerId', () => {
    const bucket = new TokenBucket('provider-a', {
      capacity: 10,
      refillPerMs: 0.01,
      initialTokens: 4,
      now: () => 500,
      wallNow: () => 1000
    })

    const snapshot = bucket.snapshot()

    expect(snapshot.providerId).toBe('provider-a')
    expect(snapshot.capacity).toBe(10)
    expect(snapshot.tokens).toBe(4)
    expect(snapshot.lastRefillMs).toBe(500)
    expect(snapshot.lastRefillWallMs).toBe(1000)
  })
})
