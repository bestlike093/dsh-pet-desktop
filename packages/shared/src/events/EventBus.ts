export type Listener<T> = (payload: T) => void

/**
 * 类型安全事件总线。
 * 单个监听器抛错不影响其他监听器，也不向上冒泡打断主循环。
 */
export class EventBus<Events extends Record<string, unknown>> {
  private readonly listeners = new Map<keyof Events, Set<Listener<never>>>()

  on<K extends keyof Events>(type: K, listener: Listener<Events[K]>): () => void {
    let set = this.listeners.get(type)
    if (set === undefined) {
      set = new Set<Listener<never>>()
      this.listeners.set(type, set)
    }
    set.add(listener as Listener<never>)
    return () => {
      this.off(type, listener)
    }
  }

  off<K extends keyof Events>(type: K, listener: Listener<Events[K]>): void {
    this.listeners.get(type)?.delete(listener as Listener<never>)
  }

  emit<K extends keyof Events>(type: K, payload: Events[K]): void {
    const set = this.listeners.get(type)
    if (set === undefined || set.size === 0) return
    for (const listener of [...set]) {
      try {
        ;(listener as Listener<Events[K]>)(payload)
      } catch {
        // 单个监听器失败不阻断其他监听器
      }
    }
  }

  count(type?: keyof Events): number {
    if (type === undefined) {
      let total = 0
      for (const set of this.listeners.values()) total += set.size
      return total
    }
    return this.listeners.get(type)?.size ?? 0
  }

  clear(): void {
    this.listeners.clear()
  }
}
