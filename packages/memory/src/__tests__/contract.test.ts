/**
 * IMemoryStore 契约现状快照。
 *
 * 这里不验证行为，只钉死两件事：
 * 1. `MemoryStore` 结构上已经实现了哪些方法；
 * 2. `syncWith` 只有契约、没有实现。
 *
 * `@ts-expect-error` 是刻意的：它证明 `MemoryStore` 当前不满足
 * `IMemoryStore`，S0 补上 `implements` + `syncWith` 后这里会报「多余的错误」，
 * 届时把 expect-error 去掉即可。
 */
import { describe, expect, it } from 'vitest'
import type { IMemoryStore } from '@pet/shared'
import { MemoryStore } from '../memoryStore.js'

describe('IMemoryStore 契约现状快照', () => {
  const store = new MemoryStore({ deviceId: 'test-device' })

  it('MemoryStore 满足 IMemoryStore（syncWith 为存根）', () => {
    const contract: IMemoryStore = store
    expect(typeof contract.append).toBe('function')
  })

  it('syncWith 抛 NOT_IMPLEMENTED，不静默成功', async () => {
    await expect(store.syncWith('peer-1')).rejects.toMatchObject({
      code: 'NOT_IMPLEMENTED',
      details: { stage: 'S8' }
    })
  })

  it('六个已实现方法都在实例上', () => {
    expect(typeof store.append).toBe('function')
    expect(typeof store.summarize).toBe('function')
    expect(typeof store.tombstone).toBe('function')
    expect(typeof store.assemble).toBe('function')
    expect(typeof store.decay).toBe('function')
    expect(typeof store.chainRoot).toBe('function')
  })

  it('syncWith 已落存根，不再是缺口', () => {
    expect('syncWith' in store).toBe(true)
  })
})

describe('记忆修订：每改一次留一版', () => {
  async function seedFact(store: MemoryStore, text: string) {
    return store.append({
      deviceId: 'test-device',
      layer: 'L2',
      kind: 'fact',
      text,
      parentIds: [],
      sessionId: 's1',
      salience: 1,
      scope: 'shared'
    })
  }

  it('revise 生成新版本，父指针指向原记录', async () => {
    const store = new MemoryStore({ deviceId: 'test-device' })
    const original = await seedFact(store, '小鹿喜欢粉色')
    const revised = await store.revise(original.id, '小鹿最喜欢粉色')

    expect(revised.kind).toBe('revision')
    expect(revised.parentIds).toEqual([original.id])
    expect(revised.sessionId).toBe(original.sessionId)
    expect(revised.text).toBe('小鹿最喜欢粉色')
  })

  it('修订后装配使用新版本，旧版本不再出现', async () => {
    const store = new MemoryStore({ deviceId: 'test-device' })
    const original = await seedFact(store, '旧的说法')
    await store.revise(original.id, '新的说法')

    const bundle = await store.assemble('s1')
    expect(bundle.facts).toContain('新的说法')
    expect(bundle.facts).not.toContain('旧的说法')
  })

  it('旧版本仍保留在快照里，可审计', async () => {
    const store = new MemoryStore({ deviceId: 'test-device' })
    const original = await seedFact(store, '第一版')
    await store.revise(original.id, '第二版')

    const ids = store.snapshot().map((record) => record.id)
    expect(ids).toContain(original.id)
  })

  it('空修订文本被拒绝', async () => {
    const store = new MemoryStore({ deviceId: 'test-device' })
    const original = await seedFact(store, '原文')
    await expect(store.revise(original.id, '   ')).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT'
    })
  })

  it('已删除的记忆不能修订', async () => {
    const store = new MemoryStore({ deviceId: 'test-device' })
    const original = await seedFact(store, '要删掉的')
    const tomb = await store.tombstone(original.id)
    await expect(store.revise(tomb.id, '不该成功')).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT'
    })
  })

  it('修订不存在的记忆返回 MEMORY_NOT_FOUND', async () => {
    const store = new MemoryStore({ deviceId: 'test-device' })
    await expect(store.revise('not-exist', 'x')).rejects.toMatchObject({
      code: 'MEMORY_NOT_FOUND'
    })
  })
})
