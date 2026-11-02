import { describe, expect, it } from 'vitest'
import { DialogueQueue } from '../../dialogue/dialogueQueue.js'
import { LocalEmotionEngine } from '../../emotion/localEmotion.js'
import { FallbackChain, PresetPool, type LlmAdapter } from '../fallbackChain.js'
import { TokenBucket } from '../tokenBucket.js'

function throwingLlm(): LlmAdapter {
  return {
    generate: async () => {
      throw new Error('provider boom')
    }
  }
}

function workingLlm(): LlmAdapter {
  return {
    generate: async () => ({
      text: 'llm 台词',
      model: 'model-x',
      promptVersion: 'prompt-v1',
      totalTokens: 'unknown'
    })
  }
}

describe('降级链：LLM → 本地规则 → 预置池（S5）', () => {
  it('LLM 成功时标记 llm，并带 model + promptVersion', async () => {
    const chain = new FallbackChain({
      llm: workingLlm(),
      localRules: new LocalEmotionEngine(),
      presetPool: new PresetPool(['预置台词'], 'test-pool')
    })

    const report = await chain.generate({ text: '你好' })

    expect(report.output.source).toBe('llm')
    expect(report.output.provenance).toEqual({
      kind: 'llm',
      model: 'model-x',
      promptVersion: 'prompt-v1'
    })
  })

  it('LLM 抛异常时 source 反映真实来源，不为 llm', async () => {
    const chain = new FallbackChain({
      llm: throwingLlm(),
      localRules: new LocalEmotionEngine(),
      presetPool: new PresetPool(['预置台词'], 'test-pool')
    })

    const report = await chain.generate({ text: '你好' })

    expect(report.output.source).toBe('local-rule')
    expect(report.output.source).not.toBe('llm')
    expect(report.output.provenance).toEqual({ kind: 'local-rule', matchedRule: 'greeting' })
  })

  it('LLM 异常且无规则命中时落到预置池，带 poolId + pickedIndex', async () => {
    const chain = new FallbackChain({
      llm: throwingLlm(),
      localRules: new LocalEmotionEngine(),
      presetPool: new PresetPool(['预置一', '预置二'], 'test-pool')
    })

    const report = await chain.generate({ text: '今天窗外有风' })

    expect(report.output.source).toBe('preset-pool')
    expect(report.output.provenance).toEqual({
      kind: 'preset-pool',
      poolId: 'test-pool',
      pickedIndex: 0
    })
  })

  it('桶空时直接降级，不调用 LLM', async () => {
    let called = 0
    const llm: LlmAdapter = {
      generate: async () => {
        called += 1
        return { text: '不该出现', model: 'm', promptVersion: 'p', totalTokens: 'unknown' }
      }
    }

    const chain = new FallbackChain({
      llm,
      localRules: new LocalEmotionEngine(),
      presetPool: new PresetPool(['预置台词'], 'test-pool'),
      bucket: new TokenBucket('provider-a', { capacity: 1, refillPerMs: 0, initialTokens: 0 })
    })

    const report = await chain.generate({ text: '你好' })

    expect(called).toBe(0)
    expect(report.output.source).toBe('local-rule')
  })

  it('桶空 + 降级成功：诊断里没有 error', async () => {
    const chain = new FallbackChain({
      llm: workingLlm(),
      localRules: new LocalEmotionEngine(),
      presetPool: new PresetPool(['预置台词'], 'test-pool'),
      bucket: new TokenBucket('provider-a', { capacity: 1, refillPerMs: 0, initialTokens: 0 })
    })

    const report = await chain.generate({ text: '你好' })

    expect(report.output.source).toBe('local-rule')
    expect(report.diagnostics.every((item) => item.level !== 'error')).toBe(true)
  })

  it('降级产出走 enqueue，优先级是 normal', async () => {
    const queue = new DialogueQueue()
    const chain = new FallbackChain({
      llm: throwingLlm(),
      localRules: new LocalEmotionEngine(),
      presetPool: new PresetPool(['预置台词'], 'test-pool'),
      queue
    })

    await chain.generateAndEnqueue({ text: '你好' })

    const [item] = queue.snapshot()
    expect(item?.priority).toBe('normal')
    expect(item?.text).toBeTruthy()
  })

  it('桶恢复后回切 llm，但不打断正在播的台词', async () => {
    let clock = 0
    const bucket = new TokenBucket('provider-a', {
      capacity: 1,
      refillPerMs: 0.001,
      initialTokens: 0,
      now: () => clock
    })
    const queue = new DialogueQueue()
    queue.enqueue({ text: '正在播', priority: 'normal' })
    queue.beginNext()

    const chain = new FallbackChain({
      llm: workingLlm(),
      localRules: new LocalEmotionEngine(),
      presetPool: new PresetPool(['预置台词'], 'test-pool'),
      bucket,
      queue
    })

    const first = await chain.generateAndEnqueue({ text: '你好' })
    expect(first.output.source).toBe('local-rule')
    expect(queue.currentItem?.text).toBe('正在播')

    clock = 10_000
    const second = await chain.generate({ text: '你好' })

    expect(second.output.source).toBe('llm')
    expect(queue.currentItem?.text).toBe('正在播')
  })

  it('三条路径的 source 都非空，且与 provenance.kind 一致', async () => {
    const reports = [
      await new FallbackChain({ llm: workingLlm() }).generate({ text: '你好' }),
      await new FallbackChain({
        llm: throwingLlm(),
        localRules: new LocalEmotionEngine()
      }).generate({ text: '你好' }),
      await new FallbackChain({
        localRules: new LocalEmotionEngine(),
        presetPool: new PresetPool(['预置台词'], 'pool-1')
      }).generate({ text: '今天窗外有风' })
    ]

    for (const report of reports) {
      expect(report.output.source).toBeTruthy()
      expect(report.output.provenance.kind).toBe(report.output.source)
    }
  })

  it('连预置池都没有时记为 error 并抛 FALLBACK_EXHAUSTED', async () => {
    const chain = new FallbackChain({
      localRules: new LocalEmotionEngine(),
      presetPool: new PresetPool([])
    })

    await expect(chain.generate({ text: '今天窗外有风' })).rejects.toThrow('FALLBACK_EXHAUSTED')
  })
})
