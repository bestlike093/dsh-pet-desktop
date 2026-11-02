import { describe, expect, it } from 'vitest'
import { ErrorCode, isPetError } from '@pet/shared'
import { LocalEmotionEngine } from '../../emotion/localEmotion.js'
import { FallbackChain, PresetPool, type FallbackDiagnostic, type LlmAdapter } from '../fallbackChain.js'
import { TokenBucket } from '../tokenBucket.js'

function llmReturning(totalTokens: number | 'unknown'): LlmAdapter {
  return {
    generate: async () => ({
      text: 'llm 台词',
      model: 'model-x',
      promptVersion: 'prompt-v1',
      totalTokens
    })
  }
}

/** 不声明 rules 时按 LOCAL_EMOTION_RULES 匹配；这里只测记账与溯源，不测规则本身。 */
describe('E-7 配额结算：缺 totalTokens 不得全额退还', () => {
  it("adapter 报 'unknown' 时保留预扣，桶不回到满值", async () => {
    const bucket = new TokenBucket('provider-a', {
      capacity: 100,
      refillPerMs: 0,
      initialTokens: 100
    })

    const chain = new FallbackChain({
      llm: llmReturning('unknown'),
      bucket,
      estimateTokens: () => 50
    })

    const report = await chain.generate({ text: '你好' })

    expect(report.output.source).toBe('llm')
    expect(bucket.tokens).toBe(50)
    expect(
      report.diagnostics.some(
        (item) => item.level === 'warn' && item.message.includes('totalTokens missing')
      )
    ).toBe(true)
  })

  it('adapter 报 totalTokens 时按实际用量结算，多扣部分退回', async () => {
    const bucket = new TokenBucket('provider-a', {
      capacity: 100,
      refillPerMs: 0,
      initialTokens: 100
    })

    const chain = new FallbackChain({
      llm: llmReturning(30),
      bucket,
      estimateTokens: () => 50
    })

    const report = await chain.generate({ text: '你好' })

    expect(report.output.source).toBe('llm')
    expect(bucket.tokens).toBe(70)
    expect(report.diagnostics.some((item) => item.message.includes('totalTokens missing'))).toBe(
      false
    )
  })

  it('运行时仍兜住省略字段的旧调用方：不退款并 warn', async () => {
    // 编译期已排除 undefined；这条模拟不走编译、直接省略字段的旧调用方。
    const legacyLlm = {
      generate: async () => ({
        text: 'llm 台词',
        model: 'model-x',
        promptVersion: 'prompt-v1'
      })
    } as unknown as LlmAdapter

    const bucket = new TokenBucket('provider-a', {
      capacity: 100,
      refillPerMs: 0,
      initialTokens: 100
    })

    const chain = new FallbackChain({
      llm: legacyLlm,
      bucket,
      estimateTokens: () => 50
    })

    const report = await chain.generate({ text: '你好' })

    expect(report.output.source).toBe('llm')
    expect(bucket.tokens).toBe(50)
    expect(
      report.diagnostics.some(
        (item) => item.level === 'warn' && item.message.includes('totalTokens missing')
      )
    ).toBe(true)
  })

  it('totalTokens 为 0 是合法用量，按实际结算而不是当成缺报', async () => {
    const bucket = new TokenBucket('provider-a', {
      capacity: 100,
      refillPerMs: 0,
      initialTokens: 100
    })

    const chain = new FallbackChain({
      llm: llmReturning(0),
      bucket,
      estimateTokens: () => 50
    })

    const report = await chain.generate({ text: '你好' })

    expect(bucket.tokens).toBe(100)
    expect(report.diagnostics.some((item) => item.message.includes('totalTokens missing'))).toBe(
      false
    )
  })
})

describe('E-8 兜底异常：诊断随 PetError 一起抛出', () => {
  it('预置池为空时抛 PetError，details 里带着 error 级诊断', async () => {
    const chain = new FallbackChain({
      localRules: new LocalEmotionEngine(),
      presetPool: new PresetPool([])
    })

    const caught = await chain.generate({ text: '今天窗外有风' }).catch((error: unknown) => error)

    expect(isPetError(caught)).toBe(true)
    if (!isPetError(caught)) throw new Error('expected PetError')

    expect(caught.code).toBe(ErrorCode.FALLBACK_EXHAUSTED)

    const diagnostics = caught.details.diagnostics as readonly FallbackDiagnostic[] | undefined
    expect(Array.isArray(diagnostics)).toBe(true)
    expect(diagnostics?.some((item) => item.level === 'error')).toBe(true)
  })
})

describe('E-9 溯源：命中规则但无台词时不冒充 matchedRule', () => {
  it('规则命中且台词表缺席时，回落通用句并标 matchedRule: null', async () => {
    const localRules = new LocalEmotionEngine({
      rules: [
        {
          id: 'no-line-rule',
          emotion: 'happy',
          confidence: 0.9,
          pattern: /无台词触发词/,
          description: '测试专用：命中但 LOCAL_RULE_LINES 没有对应条目'
        }
      ]
    })

    const chain = new FallbackChain({ localRules })

    const report = await chain.generate({ text: '无台词触发词' })

    expect(report.output.text).toBe('嗯，我在听呢♪')
    expect(report.output.provenance).toEqual({ kind: 'local-rule', matchedRule: null })
    expect(
      report.diagnostics.some(
        (item) => item.level === 'warn' && item.message.includes('rule matched without line')
      )
    ).toBe(true)
  })
})
