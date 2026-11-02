import { describe, expect, it } from 'vitest'
import {
  DEFAULT_EMOTION_TTL_MS,
  LOCAL_EMOTION_RULES,
  LocalEmotionEngine,
  analyzeLocalEmotion,
  isEmotionExpired
} from '../localEmotion.js'

describe('本地情绪规则：LLM 的兜底（S5）', () => {
  it('感谢类文本命中 gratitude，产出 happy', () => {
    const result = analyzeLocalEmotion('谢谢你，今天帮了大忙', { now: () => 1000 })

    expect(result.emotion).toBe('happy')
    expect(result.matchedRule).toBe('gratitude')
    expect(result.confidence).toBeGreaterThan(0)
    expect(result.producedAt).toBe(1000)
    expect(result.source).toBe('local')
  })

  it('无规则命中时返回 neutral，不瞎猜', () => {
    const result = analyzeLocalEmotion('今天窗外有风', { now: () => 2000 })

    expect(result.emotion).toBe('neutral')
    expect(result.confidence).toBe(0)
    expect(result.matchedRule).toBeNull()
    expect(result.producedAt).toBe(2000)
  })

  it('置信度低于阈值时退回 neutral', () => {
    const result = analyzeLocalEmotion('你好', { now: () => 3000, minConfidence: 0.9 })

    expect(result.emotion).toBe('neutral')
    expect(result.matchedRule).toBeNull()
  })

  it('规则表可枚举，id 唯一，matchedRule 一定能对上', () => {
    const ids = LOCAL_EMOTION_RULES.map((rule) => rule.id)

    expect(ids.length).toBeGreaterThan(0)
    expect(new Set(ids).size).toBe(ids.length)

    const matched = analyzeLocalEmotion('我有点难过')
    expect(matched.matchedRule).not.toBeNull()
    expect(ids).toContain(matched.matchedRule)
  })

  it('TTL 从 producedAt 起算，不是读取时刻', () => {
    let clock = 10_000
    const engine = new LocalEmotionEngine({ now: () => clock, ttlMs: 30_000 })

    const produced = engine.analyze('好累啊')
    expect(produced.producedAt).toBe(10_000)
    expect(engine.current().emotion).toBe('tired')

    clock = 10_000 + DEFAULT_EMOTION_TTL_MS
    expect(engine.current().emotion).toBe('tired')

    clock = 10_000 + DEFAULT_EMOTION_TTL_MS + 1
    expect(engine.current().emotion).toBe('neutral')
  })

  it('过期后不拿旧值兜底：matchedRule 清空、置信度归零', () => {
    let clock = 0
    const engine = new LocalEmotionEngine({ now: () => clock, ttlMs: 1000 })

    engine.analyze('气死我了')
    clock = 1001

    const current = engine.current()
    expect(current.emotion).toBe('neutral')
    expect(current.matchedRule).toBeNull()
    expect(current.confidence).toBe(0)
    expect(current.producedAt).toBe(1001)
  })

  it('isEmotionExpired 只认 producedAt 与 now 的差值', () => {
    const snapshot = { emotion: 'happy' as const, confidence: 0.8, matchedRule: 'greeting', producedAt: 100, source: 'local' as const }

    expect(isEmotionExpired(snapshot, 1100, 1000)).toBe(false)
    expect(isEmotionExpired(snapshot, 1101, 1000)).toBe(true)
  })

  it('不依赖任何 LLM provider：纯文本输入即可产出结果', () => {
    // 这个文件没有 import 任何 provider / client；本地规则独立跑通。
    const result = analyzeLocalEmotion('在吗？')

    expect(result.source).toBe('local')
    expect(result.emotion).toBe('happy')
    expect(result.matchedRule).toBe('greeting')
  })
})
