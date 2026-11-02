import { describe, expect, it } from 'vitest'
import { DailyBudgetGate } from '../dailyBudget.js'
import { MockLlmProvider, createTimeoutLlmAdapter } from '../provider.js'
import { LlmBudgetExceededError } from '../provider.js'

const DAY = new Date(2026, 9, 31, 12, 0, 0).getTime()

describe('createTimeoutLlmAdapter + DailyBudgetGate', () => {
  it('额度耗尽时直接抛错，不发起 provider 调用', async () => {
    const provider = new MockLlmProvider()
    const budget = new DailyBudgetGate({ dailyLimit: 100, now: () => DAY })
    budget.record(100)

    const adapter = createTimeoutLlmAdapter(provider, 1000, { budget })

    await expect(adapter.generate({ text: 'hi' })).rejects.toBeInstanceOf(
      LlmBudgetExceededError
    )
    expect(provider.calls).toBe(0)
  })

  it('调用成功后按真实 usage 记账', async () => {
    const provider = new MockLlmProvider({
      usage: { inputTokens: 120, outputTokens: 40 }
    })
    const budget = new DailyBudgetGate({ dailyLimit: 1000, now: () => DAY })

    const adapter = createTimeoutLlmAdapter(provider, 1000, { budget })
    const result = await adapter.generate({ text: 'hi' })

    expect(result.totalTokens).toBe(160)
    expect(budget.used).toBe(160)
    expect(budget.canSpend(840).allowed).toBe(true)
    expect(budget.canSpend(841).allowed).toBe(false)
  })

  it('usage 缺失时标 unknown，但按输入估算记账，不让额度白放', async () => {
    const provider = {
      id: 'fake',
      async generate() {
        return { text: 'x', model: 'm', promptVersion: 'v' }
      }
    }
    const budget = new DailyBudgetGate({ dailyLimit: 1000, now: () => DAY })

    const adapter = createTimeoutLlmAdapter(provider, 1000, { budget })
    const result = await adapter.generate({ text: 'hi' })

    expect(result.totalTokens).toBe('unknown')
    // 'hi' 两个字符，缺省按 3 字符 ≈ 1 token 估算，至少记 1。
    expect(budget.used).toBe(1)
  })

  it('预检会把 estimateTokens 算进去', async () => {
    const provider = new MockLlmProvider()
    const budget = new DailyBudgetGate({ dailyLimit: 1000, now: () => DAY })
    budget.record(900)

    const adapter = createTimeoutLlmAdapter(provider, 1000, {
      budget,
      estimateTokens: 200
    })

    await expect(adapter.generate({ text: 'hi' })).rejects.toBeInstanceOf(
      LlmBudgetExceededError
    )
    expect(provider.calls).toBe(0)
  })

  it('不传 budget 时行为与原来一致', async () => {
    const provider = new MockLlmProvider()
    const adapter = createTimeoutLlmAdapter(provider, 1000)

    const result = await adapter.generate({ text: 'hi' })

    expect(provider.calls).toBe(1)
    expect(result.totalTokens).toBe(2)
  })
})
