/**
 * 带 TTL 的结果缓存。
 *
 * 来自宿主 builtin-tools/ttl-result-cache 的做法：同类查询在一次会话里
 * 会连着来好几次（问完天气问穿衣、问完汇率问换算），每次都打一次外部
 * 接口既慢又费额度。缓存按 key 存，过期就丢，不做持久化。
 *
 * 两个刻意保留的约束：
 *
 * 1. 时间由外部注入，不读 Date.now()。测试要能精确控制「过期」这件事，
 *    否则只能靠 sleep 等真实时间，慢且不稳。
 * 2. 同一个 key 的并发请求只放一个人去打，其余等结果。否则缓存反而
 *    放大了瞬时并发——第一次请求还没回来时，后面几个都是 miss。
 */

export interface CacheEntry<T> {
  readonly value: T
  readonly expiresAt: number
}

export interface CacheOptions {
  /** 缓存条数上限，超出时先清过期的，再按插入顺序淘汰最旧的。默认 128。 */
  readonly maxEntries?: number
}

export class TtlCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>()
  private readonly inflight = new Map<string, Promise<T>>()
  private readonly maxEntries: number

  constructor(
    private readonly now: () => number,
    options: CacheOptions = {}
  ) {
    this.maxEntries = Math.max(1, options.maxEntries ?? 128)
  }

  /** 命中且未过期返回值，否则 null。过期的条目顺手清掉。 */
  get(key: string): T | null {
    const entry = this.entries.get(key)
    if (entry === undefined) return null

    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key)
      return null
    }

    return entry.value
  }

  set(key: string, value: T, ttlMs: number): void {
    if (ttlMs <= 0) {
      this.entries.delete(key)
      return
    }

    // 先删再插，让 Map 的插入顺序等于「最近一次写入」，
    // 淘汰时才能稳定地丢最旧的那条。
    this.entries.delete(key)
    this.entries.set(key, { value, expiresAt: this.now() + ttlMs })

    if (this.entries.size > this.maxEntries) this.evict()
  }

  delete(key: string): boolean {
    return this.entries.delete(key)
  }

  clear(): void {
    this.entries.clear()
    this.inflight.clear()
  }

  get size(): number {
    this.prune()
    return this.entries.size
  }

  /** 清掉所有已过期条目，返回清掉的条数。 */
  prune(): number {
    const now = this.now()
    let removed = 0
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(key)
        removed += 1
      }
    }
    return removed
  }

  /**
   * 取值，没有就调 `load` 去拿。
   *
   * `load` 抛错时不写缓存，也不留痕——下一次调用会重新尝试。
   * 失败结果不能被缓存成「成功」，否则一次网络抖动会让空值活很久。
   */
  async remember(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    const cached = this.get(key)
    if (cached !== null) return cached

    const pending = this.inflight.get(key)
    if (pending !== undefined) return pending

    const task = (async () => {
      try {
        const value = await load()
        this.set(key, value, ttlMs)
        return value
      } finally {
        this.inflight.delete(key)
      }
    })()

    this.inflight.set(key, task)
    return task
  }

  private evict(): void {
    this.prune()
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next()
      if (oldest.done === true) break
      this.entries.delete(oldest.value)
    }
  }
}
