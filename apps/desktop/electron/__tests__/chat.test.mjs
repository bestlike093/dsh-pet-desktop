import { describe, expect, it, vi } from 'vitest'
import { createChatService } from '../chat.mjs'

const SETTINGS = { companion: { chat: { enabled: true } } }

function makeService(overrides = {}) {
  return createChatService({
    getSettings: () => SETTINGS,
    getApiKey: async () => 'sk-test',
    getPersonaText: () => '',
    getMemoryDigest: () => '',
    fetchImpl: vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        model: 'deepseek-chat',
        choices: [{ message: { content: '我在听' } }]
      })
    })),
    log: vi.fn(),
    ...overrides
  })
}

describe('聊天落盘契约', () => {
  /**
   * 锁定当前语义：两条 turn 逐条落盘，互不回滚。
   * 将来若改成事务式写入，这条会先红，逼改动者显式决策。
   */
  it('persistTurn 第二条失败时不回滚第一条，保留有问无答', async () => {
    const saved = []
    const persistTurn = vi.fn((turn) => {
      if (turn.role === 'assistant') throw new Error('disk full')
      saved.push(turn)
    })
    const persistClear = vi.fn()
    const log = vi.fn()
    const service = makeService({ persistTurn, persistClear, log })

    const result = await service.send({ text: '睡不着' })

    // 回复照常返回，落盘错误不向渲染层抛。
    expect(result).toMatchObject({ ok: true, reply: '我在听' })

    // 第一条已在磁盘，第二条不在；没有任何补偿删除。
    expect(persistTurn).toHaveBeenCalledTimes(2)
    expect(saved).toHaveLength(1)
    expect(saved[0]).toMatchObject({ role: 'user', content: '睡不着' })
    expect(persistClear).not.toHaveBeenCalled()

    // 错误只走 log 一处。
    expect(log).toHaveBeenCalledWith('聊天历史落盘失败：', 'disk full')
    expect(log).toHaveBeenCalledTimes(1)

    // 模拟重启：从「磁盘」接回后只剩有问无答。
    const restarted = makeService()
    expect(restarted.hydrate(saved)).toBe(1)
    expect(restarted.history()).toEqual([
      { role: 'user', content: '睡不着', at: expect.any(String) }
    ])
  })
})

describe('聊天清空契约', () => {
  const SAVED = [
    { role: 'user', content: '你好', at: '2026-01-01T00:00:00.000Z' },
    { role: 'assistant', content: '在的', at: '2026-01-01T00:00:01.000Z' }
  ]

  it('persistClear 成功后才清 turns，返回 ok:true', async () => {
    const persistClear = vi.fn(async () => ({ ok: true }))
    const service = makeService({ persistClear })
    service.hydrate(SAVED)

    const result = await service.clear()

    expect(result).toEqual({ ok: true })
    expect(persistClear).toHaveBeenCalledTimes(1)
    expect(service.history()).toEqual([])
  })

  it('persistClear 返回失败时 turns 一字不动，返回 persist-failed', async () => {
    const persistClear = vi.fn(async () => ({ ok: false, reason: 'persist-failed' }))
    const service = makeService({ persistClear })
    service.hydrate(SAVED)
    const before = service.history()

    const result = await service.clear()

    expect(result).toEqual({ ok: false, reason: 'persist-failed' })
    expect(service.history()).toEqual(before)
  })

  it('persistClear 抛错时不向渲染层抛，turns 一字不动', async () => {
    const persistClear = vi.fn(async () => {
      throw new Error('disk full')
    })
    const service = makeService({ persistClear })
    service.hydrate(SAVED)
    const before = service.history()

    const result = await service.clear()

    expect(result).toEqual({ ok: false, reason: 'persist-failed' })
    expect(service.history()).toEqual(before)
  })
})
