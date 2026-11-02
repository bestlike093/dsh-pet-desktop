import { describe, expect, it } from 'vitest'
import { DialogueQueue } from '../../dialogue/dialogueQueue.js'
import { LocalEmotionEngine } from '../../emotion/localEmotion.js'
import { FallbackChain, PresetPool, type LlmAdapter } from '../fallbackChain.js'
import { MockLlmProvider, createTimeoutLlmAdapter } from '../provider.js'
import { TokenBucket } from '../tokenBucket.js'

describe('LLM provider 抽象与超时（S5）', () => {
  it('mock 正常返回时标记 llm，并带 model / promptVersion', async () => {
    const provider = new MockLlmProvider({ text: 'mock 台词', model: 'mock-x', promptVersion: 'p-1' })
    const chain = new FallbackChain({ llm: createTimeoutLlmAdapter(provider, 100) })

    const report = await chain.generate({ text: '你好' })

    expect(provider.calls).toBe(1)
    expect(report.output.source).toBe('llm')
    expect(report.output.provenance).toEqual({
      kind: 'llm',
      model: 'mock-x',
      promptVersion: 'p-1'
    })
  })

  it('mock 抛异常时落到本地规则，source 不为 llm', async () => {
    const chain = new FallbackChain({
      llm: createTimeoutLlmAdapter(new MockLlmProvider({ mode: 'throw' }), 100),
      localRules: new LocalEmotionEngine(),
      presetPool: new PresetPool(['预置'], 'pool')
    })

    const report = await chain.generate({ text: '你好' })

    expect(report.output.source).toBe('local-rule')
  })

  it('mock 永不 resolve：超时触发、abort 被调用、source 不为 llm', async () => {
    const provider = new MockLlmProvider({ mode: 'hang' })
    const chain = new FallbackChain({
      llm: createTimeoutLlmAdapter(provider, 20),
      localRules: new LocalEmotionEngine(),
      presetPool: new PresetPool(['预置'], 'pool')
    })

    const report = await chain.generate({ text: '你好' })

    expect(provider.aborted).toBe(true)
    expect(provider.lastSignal?.aborted).toBe(true)
    expect(report.output.source).not.toBe('llm')
    expect(report.output.source).toBe('local-rule')
  })

  it('超时后退还预扣令牌', async () => {
    const provider = new MockLlmProvider({ mode: 'hang' })
    const bucket = new TokenBucket('provider-a', {
      capacity: 10,
      refillPerMs: 0,
      initialTokens: 10
    })
    const chain = new FallbackChain({
      llm: createTimeoutLlmAdapter(provider, 20),
      localRules: new LocalEmotionEngine(),
      presetPool: new PresetPool(['预置'], 'pool'),
      bucket
    })

    await chain.generate({ text: '你好' })

    expect(bucket.snapshot().tokens).toBe(10)
  })

  it('超时后走降级链并入队 normal，不产生 error 诊断', async () => {
    const queue = new DialogueQueue()
    const chain = new FallbackChain({
      llm: createTimeoutLlmAdapter(new MockLlmProvider({ mode: 'hang' }), 20),
      localRules: new LocalEmotionEngine(),
      presetPool: new PresetPool(['预置'], 'pool'),
      queue
    })

    const report = await chain.generateAndEnqueue({ text: '你好' })

    expect(report.output.source).toBe('local-rule')
    expect(report.diagnostics.every((item) => item.level !== 'error')).toBe(true)
    expect(queue.snapshot()[0]?.priority).toBe('normal')
  })

  it('非法 timeout 明确抛错，不静默退化为无超时', () => {
    expect(() => createTimeoutLlmAdapter(new MockLlmProvider(), 0)).toThrow()
    expect(() => createTimeoutLlmAdapter(new MockLlmProvider(), Number.NaN)).toThrow()
  })

  it('每次请求都拿一个新的 signal，互不复用', async () => {
    const provider = new MockLlmProvider()
    const adapter: LlmAdapter = createTimeoutLlmAdapter(provider, 100)

    await adapter.generate({ text: '第一次' })
    await adapter.generate({ text: '第二次' })

    expect(provider.calls).toBe(2)
  })

  it("provider 不返回 usage 时 totalTokens 为 'unknown'，不猜 0", async () => {
    const adapter = createTimeoutLlmAdapter(
      {
        id: 'no-usage',
        generate: async () => ({
          text: '无用量台词',
          model: 'model-y',
          promptVersion: 'p-2'
        })
      },
      100
    )

    const raw = await adapter.generate({ text: '你好' })

    expect(raw.totalTokens).toBe('unknown')
  })

  it('provider 返回 usage 时 totalTokens 为两字段之和', async () => {
    const provider = new MockLlmProvider({ usage: { inputTokens: 3, outputTokens: 7 } })
    const adapter = createTimeoutLlmAdapter(provider, 100)

    const raw = await adapter.generate({ text: '你好' })

    expect(raw.totalTokens).toBe(10)
  })
})
