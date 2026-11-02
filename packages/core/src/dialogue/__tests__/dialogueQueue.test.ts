import { describe, expect, it } from 'vitest'
import { DialogueQueue } from '../dialogueQueue.js'

describe('台词队列：优先级与顺序（S5 最小验收）', () => {
  it('enqueue 三条后按优先级 dequeue：approval → normal → idle', () => {
    const queue = new DialogueQueue()

    queue.enqueue({ text: '低优先级', priority: 'idle' })
    queue.enqueue({ text: '普通台词', priority: 'normal' })
    queue.enqueue({ text: '审批请求', priority: 'approval' })

    expect(queue.dequeue()?.text).toBe('审批请求')
    expect(queue.dequeue()?.text).toBe('普通台词')
    expect(queue.dequeue()?.text).toBe('低优先级')
    expect(queue.dequeue()).toBeUndefined()
  })

  it('同级按入队顺序出队', () => {
    const queue = new DialogueQueue()

    queue.enqueue({ text: '第一句', priority: 'normal' })
    queue.enqueue({ text: '第二句', priority: 'normal' })
    queue.enqueue({ text: '第三句', priority: 'normal' })

    expect(queue.dequeue()?.text).toBe('第一句')
    expect(queue.dequeue()?.text).toBe('第二句')
    expect(queue.dequeue()?.text).toBe('第三句')
  })

  it('高优先级后到也能先出队', () => {
    const queue = new DialogueQueue()

    queue.enqueue({ text: '先来的普通', priority: 'normal' })
    queue.enqueue({ text: '后到的打断', priority: 'interrupt' })

    expect(queue.dequeue()?.text).toBe('后到的打断')
    expect(queue.dequeue()?.text).toBe('先来的普通')
  })

  it('peek 不改变队列，size 与 snapshot 一致', () => {
    const queue = new DialogueQueue()

    queue.enqueue({ text: '普通', priority: 'normal' })
    queue.enqueue({ text: '审批', priority: 'approval' })

    expect(queue.peek()?.text).toBe('审批')
    expect(queue.size).toBe(2)
    expect(queue.snapshot().map((item) => item.text)).toEqual(['普通', '审批'])
    expect(queue.dequeue()?.text).toBe('审批')
  })

  it('空队列 dequeue / peek 返回 undefined', () => {
    const queue = new DialogueQueue()

    expect(queue.dequeue()).toBeUndefined()
    expect(queue.peek()).toBeUndefined()
  })

  it('clear 清空待播台词', () => {
    const queue = new DialogueQueue()
    queue.enqueue({ text: 'a', priority: 'normal' })
    queue.enqueue({ text: 'b', priority: 'approval' })

    queue.clear()

    expect(queue.size).toBe(0)
    expect(queue.dequeue()).toBeUndefined()
  })

  it('interrupt 保留 approval，normal 全清并计入 droppedCount', () => {
    const queue = new DialogueQueue()
    queue.enqueue({ text: '审批请求', priority: 'approval' })
    queue.enqueue({ text: '普通 1', priority: 'normal' })
    queue.enqueue({ text: '普通 2', priority: 'normal' })
    queue.enqueue({ text: '普通 3', priority: 'normal' })

    const result = queue.interrupt()

    expect(result.dropped).toBe(3)
    expect(result.droppedCount).toBe(3)
    expect(queue.snapshot().map((item) => item.text)).toEqual(['审批请求'])
  })

  it('正在播的那条是 interrupted，不触发 onComplete', () => {
    const completed: string[] = []
    const interrupted: string[] = []

    const queue = new DialogueQueue({
      listeners: {
        onComplete: (item) => completed.push(item.text),
        onInterrupted: (item) => interrupted.push(item.text)
      }
    })

    queue.enqueue({ text: '正在播', priority: 'normal' })
    queue.beginNext()

    const result = queue.interrupt()

    expect(result.interrupted?.text).toBe('正在播')
    expect(interrupted).toEqual(['正在播'])
    expect(completed).toEqual([])
    expect(queue.currentItem).toBeUndefined()
  })

  it('正常播完才触发 onComplete', () => {
    const completed: string[] = []
    const queue = new DialogueQueue({
      listeners: { onComplete: (item) => completed.push(item.text) }
    })

    queue.enqueue({ text: '播完的台词', priority: 'normal' })
    queue.beginNext()
    queue.complete()

    expect(completed).toEqual(['播完的台词'])
    expect(queue.currentItem).toBeUndefined()
  })

  it('被清掉的待播逐条触发 onDropped，保留 approval', () => {
    const dropped: string[] = []
    const queue = new DialogueQueue({
      listeners: { onDropped: (item) => dropped.push(item.text) }
    })

    queue.enqueue({ text: '普通', priority: 'normal' })
    queue.enqueue({ text: '告警', priority: 'interrupt' })
    queue.enqueue({ text: '审批', priority: 'approval' })

    queue.interrupt()

    expect(dropped).toEqual(['普通', '告警'])
    expect(queue.snapshot().map((item) => item.text)).toEqual(['审批'])
  })

  it('空队列 interrupt 是 no-op，连调两次第二次也不抛错', () => {
    const queue = new DialogueQueue()

    const first = queue.interrupt()
    const second = queue.interrupt()

    expect(first.dropped).toBe(0)
    expect(second.dropped).toBe(0)
    expect(queue.droppedCount).toBe(0)
    expect(queue.size).toBe(0)
  })

  it('interrupt 后可继续 enqueue，不进入终态', () => {
    const queue = new DialogueQueue()

    queue.enqueue({ text: '旧台词', priority: 'normal' })
    queue.interrupt()
    const next = queue.enqueue({ text: '新台词', priority: 'normal' })

    expect(next?.text).toBe('新台词')
    expect(queue.size).toBe(1)
    expect(queue.isDisposed).toBe(false)
  })

  it('dispose 后 enqueue / interrupt 全部 no-op 且不抛错', () => {
    const queue = new DialogueQueue()
    queue.enqueue({ text: '待播', priority: 'normal' })

    queue.dispose()

    expect(queue.isDisposed).toBe(true)
    expect(queue.enqueue({ text: '之后', priority: 'approval' })).toBeUndefined()
    expect(() => queue.interrupt()).not.toThrow()
    expect(queue.size).toBe(0)
    expect(queue.currentItem).toBeUndefined()
  })
})

describe('旧 E-10：clear / dispose 的丢弃记账', () => {
  it('clear 把待播逐条计入 dropped 并触发 onDropped', () => {
    const dropped: string[] = []
    const queue = new DialogueQueue({
      listeners: { onDropped: (item) => dropped.push(item.text) }
    })

    queue.enqueue({ text: '待播 A', priority: 'normal' })
    queue.enqueue({ text: '待播 B', priority: 'approval' })

    queue.clear()

    expect(dropped).toEqual(['待播 A', '待播 B'])
    expect(queue.droppedCount).toBe(2)
    expect(queue.size).toBe(0)
  })

  it('dispose 把在播 + 待播一起计入 dropped，在播条走 onDropped 而非 onInterrupted', () => {
    const dropped: string[] = []
    const interrupted: string[] = []

    const queue = new DialogueQueue({
      listeners: {
        onDropped: (item) => dropped.push(item.text),
        onInterrupted: (item) => interrupted.push(item.text)
      }
    })

    queue.enqueue({ text: '在播', priority: 'normal' })
    queue.beginNext()
    queue.enqueue({ text: '待播 1', priority: 'normal' })
    queue.enqueue({ text: '待播 2', priority: 'approval' })

    queue.dispose()

    expect(dropped).toEqual(['在播', '待播 1', '待播 2'])
    expect(interrupted).toEqual([])
    expect(queue.droppedCount).toBe(3)
    expect(queue.size).toBe(0)
    expect(queue.currentItem).toBeUndefined()
  })

  it('dispose 重复调用不重复计数', () => {
    const dropped: string[] = []
    const queue = new DialogueQueue({
      listeners: { onDropped: (item) => dropped.push(item.text) }
    })

    queue.enqueue({ text: '待播', priority: 'normal' })

    queue.dispose()
    queue.dispose()

    expect(dropped).toEqual(['待播'])
    expect(queue.droppedCount).toBe(1)
  })

  it('dispose 之后 clear 不再重复记账', () => {
    const queue = new DialogueQueue()
    queue.enqueue({ text: '待播', priority: 'normal' })

    queue.dispose()
    queue.clear()

    expect(queue.droppedCount).toBe(1)
  })
})
