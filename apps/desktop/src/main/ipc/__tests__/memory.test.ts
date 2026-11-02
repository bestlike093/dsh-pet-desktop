import { describe, expect, it, vi } from 'vitest'
import { registerMemoryChannels } from '../memory.js'

type Handler = (event: unknown, payload?: unknown) => unknown
type FakeRecord = { id: string; text: string }

function harness(
  overrides: {
    available?: boolean
    clear?: () => unknown
    records?: FakeRecord[]
  } = {}
) {
  const handlers = new Map<string, Handler>()
  const records = overrides.records ?? []
  const clear = overrides.clear ?? vi.fn(async () => ({ ok: true }))
  const flush = vi.fn(async () => {})
  const store = {
    stats: () => ({ available: overrides.available ?? true, count: records.length }),
    remove: vi.fn(),
    clear,
    flush,
    // 模拟真实 store 的重新加载：从当前记录恢复出一份新数组。
    hydrate: () => records.map((item) => ({ ...item }))
  }

  registerMemoryChannels({
    registerChannel: (name, handler) => handlers.set(name, handler as Handler),
    memoryStore: store,
    collectMemoryAll: () => [],
    sanitizeReflectionText: (text) => text,
    dialog: { showSaveDialog: vi.fn() },
    documentsDir: 'C:/docs',
    pathJoin: (...parts) => parts.join('/'),
    writeFile: vi.fn(),
    log: vi.fn()
  })

  return { handlers, clear, flush, store, records }
}

describe('memory clear 通道', () => {
  it('clear 完成后才返回，await 期间内存尚未清空', async () => {
    const items = [{ id: '1' }]
    let finish: (() => void) | undefined
    let clearDone = false
    const clear = vi.fn(
      () =>
        new Promise((resolve) => {
          finish = () => {
            clearDone = true
            items.length = 0
            resolve({ ok: true })
          }
        })
    )
    const { handlers, flush } = harness({ clear })
    flush.mockImplementation(async () => {
      // flush 只能在 clear 成功之后发生，不能提前，也不能被漏掉。
      expect(clearDone).toBe(true)
    })

    const pending = handlers.get('pet:memory:clear')!(null)

    // 副作用还没发生，通道不能提前返回。
    expect(items).toHaveLength(1)
    finish!()
    await expect(pending).resolves.toEqual({ ok: true })
    expect(items).toEqual([])
    expect(flush).toHaveBeenCalledTimes(1)
  })

  it('store 返回 persist-failed 时通道仍回 ok:true，不把已触发的清理当失败', async () => {
    const clear = vi.fn(async () => ({ ok: false, reason: 'persist-failed' }))
    const { handlers, flush } = harness({ clear })

    await expect(handlers.get('pet:memory:clear')!(null)).resolves.toEqual({ ok: true })
    expect(clear).toHaveBeenCalledTimes(1)
    expect(flush).toHaveBeenCalledTimes(1)
  })

  it('store 返回失败时通道仍回 ok:true，恢复后的记录逐条不变', async () => {
    const records = [
      { id: '1', text: '第一句' },
      { id: '2', text: '第二句' }
    ]
    const before = records.map((item) => ({ ...item }))
    const clear = vi.fn(async () => {
      // 模拟真实 store：先清空，落盘失败后恢复原数组。
      const saved = records.map((item) => ({ ...item }))
      records.length = 0
      records.push(...saved)
      return { ok: false, reason: 'disk-full' }
    })
    const { handlers, store } = harness({ clear, records })

    await expect(handlers.get('pet:memory:clear')!(null)).resolves.toEqual({ ok: true })
    expect(store.hydrate()).toEqual(before)
  })

  it('store 直接抛错时通道不死，仍回 ok:true', async () => {
    const clear = vi.fn(async () => {
      throw new Error('disk exploded')
    })
    const { handlers, flush } = harness({ clear })

    await expect(handlers.get('pet:memory:clear')!(null)).resolves.toEqual({ ok: true })
    expect(clear).toHaveBeenCalledTimes(1)
    expect(flush).not.toHaveBeenCalled()
  })

  it('存储不可用时直接拒绝，不调用 clear', async () => {
    const { handlers, clear } = harness({ available: false })

    await expect(handlers.get('pet:memory:clear')!(null)).resolves.toEqual({
      ok: false,
      reason: 'vault-unavailable'
    })
    expect(clear).not.toHaveBeenCalled()
  })
})
