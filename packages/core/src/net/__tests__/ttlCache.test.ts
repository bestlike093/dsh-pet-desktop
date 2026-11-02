import { describe, expect, it, vi } from 'vitest'
import { TtlCache } from '../ttlCache'

function clock(start = 1000) {
  let now = start
  return {
    now: () => now,
    advance(ms: number) {
      now += ms
    }
  }
}

describe('TtlCache：命中与过期', () => {
  it('写进去能读出来', () => {
    const c = clock()
    const cache = new TtlCache<string>(c.now)
    cache.set('a', 'hello', 1000)
    expect(cache.get('a')).toBe('hello')
  })

  it('没写过的 key 返回 null', () => {
    const cache = new TtlCache<string>(clock().now)
    expect(cache.get('missing')).toBeNull()
  })

  it('到点就失效，边界那一毫秒也算过期', () => {
    const c = clock()
    const cache = new TtlCache<string>(c.now)
    cache.set('a', 'v', 1000)
    c.advance(999)
    expect(cache.get('a')).toBe('v')
    c.advance(1)
    expect(cache.get('a')).toBeNull()
  })

  it('ttl 为 0 等于不缓存', () => {
    const cache = new TtlCache<string>(clock().now)
    cache.set('a', 'v', 0)
    expect(cache.get('a')).toBeNull()
  })

  it('负数 ttl 也按不缓存处理', () => {
    const cache = new TtlCache<string>(clock().now)
    cache.set('a', 'v', -5)
    expect(cache.get('a')).toBeNull()
  })

  it('重写同一个 key 会刷新过期时间', () => {
    const c = clock()
    const cache = new TtlCache<string>(c.now)
    cache.set('a', 'v1', 1000)
    c.advance(800)
    cache.set('a', 'v2', 1000)
    c.advance(800)
    expect(cache.get('a')).toBe('v2')
  })
})

describe('TtlCache：容量', () => {
  it('超出上限时淘汰最旧的', () => {
    const c = clock()
    const cache = new TtlCache<string>(c.now, { maxEntries: 3 })
    cache.set('a', '1', 10_000)
    cache.set('b', '2', 10_000)
    cache.set('c', '3', 10_000)
    cache.set('d', '4', 10_000)

    expect(cache.get('a')).toBeNull()
    expect(cache.get('b')).toBe('2')
    expect(cache.get('d')).toBe('4')
  })

  it('淘汰前先清过期条目，不误伤还活着的', () => {
    const c = clock()
    const cache = new TtlCache<string>(c.now, { maxEntries: 2 })
    cache.set('old', 'x', 100)
    c.advance(200)
    cache.set('a', '1', 10_000)
    cache.set('b', '2', 10_000)

    expect(cache.get('a')).toBe('1')
    expect(cache.get('b')).toBe('2')
  })

  it('prune 返回清掉的条数', () => {
    const c = clock()
    const cache = new TtlCache<string>(c.now)
    cache.set('a', '1', 100)
    cache.set('b', '2', 100)
    cache.set('c', '3', 10_000)
    c.advance(200)
    expect(cache.prune()).toBe(2)
  })
})

describe('TtlCache：remember', () => {
  it('没有缓存时调 load 并写入', async () => {
    const cache = new TtlCache<number>(clock().now)
    const load = vi.fn(async () => 42)
    await expect(cache.remember('k', 1000, load)).resolves.toBe(42)
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('第二次直接命中，不再调 load', async () => {
    const cache = new TtlCache<number>(clock().now)
    const load = vi.fn(async () => 42)
    await cache.remember('k', 1000, load)
    await cache.remember('k', 1000, load)
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('过期后会重新加载', async () => {
    const c = clock()
    const cache = new TtlCache<number>(c.now)
    const load = vi.fn(async () => 42)
    await cache.remember('k', 1000, load)
    c.advance(1000)
    await cache.remember('k', 1000, load)
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('同一个 key 并发只打一次', async () => {
    const cache = new TtlCache<number>(clock().now)
    let resolveLoad: (value: number) => void = () => {}
    const load = vi.fn(
      () =>
        new Promise<number>((resolve) => {
          resolveLoad = resolve
        })
    )

    const a = cache.remember('k', 1000, load)
    const b = cache.remember('k', 1000, load)
    const c = cache.remember('k', 1000, load)

    resolveLoad(7)
    await expect(Promise.all([a, b, c])).resolves.toEqual([7, 7, 7])
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('不同 key 并发互不影响', async () => {
    const cache = new TtlCache<string>(clock().now)
    const load = vi.fn(async (key: string) => key)
    const [a, b] = await Promise.all([
      cache.remember('x', 1000, () => load('x')),
      cache.remember('y', 1000, () => load('y'))
    ])
    expect([a, b]).toEqual(['x', 'y'])
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('load 抛错时不写缓存，下次还会再试', async () => {
    const cache = new TtlCache<number>(clock().now)
    const load = vi.fn(async () => {
      throw new Error('boom')
    })

    await expect(cache.remember('k', 1000, load)).rejects.toThrow('boom')
    expect(cache.get('k')).toBeNull()

    await expect(cache.remember('k', 1000, load)).rejects.toThrow('boom')
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('load 抛错后，inflight 不会把失败结果留成副本', async () => {
    const cache = new TtlCache<number>(clock().now)
    let attempt = 0
    const load = vi.fn(async () => {
      attempt += 1
      if (attempt === 1) throw new Error('first')
      return 99
    })

    await expect(cache.remember('k', 1000, load)).rejects.toThrow('first')
    await expect(cache.remember('k', 1000, load)).resolves.toBe(99)
  })

  it('缓存值是 null 时不能用命中判断，必须靠 get', async () => {
    const cache = new TtlCache<null>(clock().now)
    cache.set('k', null, 1000)
    expect(cache.get('k')).toBeNull()

    const load = vi.fn(async () => 1 as unknown as null)
    await cache.remember('k', 1000, load)
    expect(load).toHaveBeenCalledTimes(1)
  })
})

describe('TtlCache：清理', () => {
  it('delete 只删指定 key', () => {
    const cache = new TtlCache<string>(clock().now)
    cache.set('a', '1', 1000)
    cache.set('b', '2', 1000)
    expect(cache.delete('a')).toBe(true)
    expect(cache.get('b')).toBe('2')
  })

  it('clear 全清', () => {
    const cache = new TtlCache<string>(clock().now)
    cache.set('a', '1', 1000)
    cache.clear()
    expect(cache.get('a')).toBeNull()
  })

  it('size 不把过期条目算进去', () => {
    const c = clock()
    const cache = new TtlCache<string>(c.now)
    cache.set('a', '1', 100)
    cache.set('b', '2', 10_000)
    c.advance(200)
    expect(cache.size).toBe(1)
  })
})
