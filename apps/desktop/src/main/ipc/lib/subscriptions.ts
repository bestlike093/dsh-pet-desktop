/**
 * 按 sender + 会话登记的订阅登记簿。聊天与语音共用同一副骨架。
 *
 * 契约：
 * - 先删后放行：dispose 先移除登记，再逐条释放；异步帧查不到旧 id。
 * - 异常安全：单条释放抛错不阻断其余，错误聚合后抛，不静默吞掉。
 * - 双键粒度：dispose(sender, convId) 只关一个会话的流；dispose(sender) 才是窗口销毁。
 */
export type Dispose = () => void

const DEFAULT_CONVERSATION = ''

export class SubscriptionRegistry {
  private readonly registry = new Map<number, Map<string, Set<Dispose>>>()

  add(senderId: number, dispose: Dispose): void {
    this.addConversation(senderId, DEFAULT_CONVERSATION, dispose)
  }

  addConversation(senderId: number, convId: string, dispose: Dispose): void {
    let conversations = this.registry.get(senderId)
    if (conversations === undefined) {
      conversations = new Map()
      this.registry.set(senderId, conversations)
    }
    let set = conversations.get(convId)
    if (set === undefined) {
      set = new Set()
      conversations.set(convId, set)
    }
    set.add(dispose)
  }

  remove(senderId: number, dispose: Dispose): void {
    const conversations = this.registry.get(senderId)
    if (conversations === undefined) return
    for (const [convId, set] of conversations) {
      set.delete(dispose)
      if (set.size === 0) conversations.delete(convId)
    }
    if (conversations.size === 0) this.registry.delete(senderId)
  }

  dispose(senderId: number, convId?: string): void {
    const conversations = this.registry.get(senderId)
    if (conversations === undefined) return

    if (convId !== undefined) {
      const set = conversations.get(convId)
      if (set === undefined) return
      conversations.delete(convId)
      if (conversations.size === 0) this.registry.delete(senderId)
      this.throwIfFailed(senderId, this.release(set))
      return
    }

    this.registry.delete(senderId)
    const failures: unknown[] = []
    for (const set of conversations.values()) {
      failures.push(...this.release(set))
    }
    this.throwIfFailed(senderId, failures)
  }

  has(senderId: number, convId?: string): boolean {
    const conversations = this.registry.get(senderId)
    if (conversations === undefined) return false
    if (convId === undefined) return conversations.size > 0
    return conversations.has(convId)
  }

  size(senderId: number, convId?: string): number {
    const conversations = this.registry.get(senderId)
    if (conversations === undefined) return 0
    if (convId !== undefined) return conversations.get(convId)?.size ?? 0

    let total = 0
    for (const set of conversations.values()) total += set.size
    return total
  }

  senderIds(): number[] {
    return [...this.registry.keys()]
  }

  reset(): void {
    this.registry.clear()
  }

  private release(set: Set<Dispose>): unknown[] {
    const failures: unknown[] = []
    for (const dispose of set) {
      try {
        dispose()
      } catch (error) {
        failures.push(error)
      }
    }
    return failures
  }

  private throwIfFailed(senderId: number, failures: unknown[]): void {
    if (failures.length === 0) return
    throw new AggregateError(
      failures,
      `订阅释放失败：sender ${senderId} 有 ${failures.length} 条监听器抛错`
    )
  }
}
