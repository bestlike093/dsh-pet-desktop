import { describe, expect, it } from 'vitest'

import { ReflectionEngine } from '../reflection.js'
import { CompanionCore } from '../companionCore.js'

describe('陪伴核心：一轮对话', () => {
  it('用户说话后能拿到心情、情感标签和表情候选', () => {
    const core = new CompanionCore({ now: () => 0 })
    const context = core.onUserMessage('今天面试过了，太开心了')

    expect(context.mood.valence).toBeGreaterThan(0)
    expect(context.emotion).toBeTruthy()
    expect(context.moodNote.length).toBeGreaterThan(0)
    expect(context.emoji.length).toBeGreaterThan(0)
  })

  it('记住的事会在下一轮被召回', () => {
    const core = new CompanionCore({ now: () => 0 })
    core.onUserMessage('我住在重庆')

    const context = core.onUserMessage('重庆')
    expect(context.memoryNote).toContain('重庆')
    expect(context.memories.length).toBeGreaterThan(0)
  })

  it('emojiLimit 为 0 时这一轮不发图', () => {
    const core = new CompanionCore({ now: () => 0, emojiLimit: 0 })
    expect(core.onUserMessage('你好呀').emoji).toHaveLength(0)
  })

  it('用过的表情在下一轮会被压分', () => {
    const plain = new CompanionCore({ now: () => 0, emojiLimit: 40 })
    const used = new CompanionCore({ now: () => 0, emojiLimit: 40 })

    const pool = plain.onUserMessage('太开心了').emoji
    const target = pool[0]
    expect(target).toBeDefined()
    if (target === undefined) return

    used.onAssistantReply('好耶', target.entry.id)

    const before = target.score
    const after = used
      .onUserMessage('太开心了')
      .emoji.find((item) => item.entry.id === target.entry.id)?.score

    expect(after).toBeDefined()
    expect(after ?? 0).toBeLessThan(before)
    expect(used.recentEmoji[0]).toBe(target.entry.id)
  })

  it('轮数到了才产出反思，且反思不会污染聊天文本', () => {
    const core = new CompanionCore({
      now: () => 0,
      reflection: new ReflectionEngine({ now: () => 0, everyTurns: 2 })
    })

    expect(core.onUserMessage('今天有点累').reflection).toBeNull()
    const second = core.onUserMessage('明天还要早起')
    expect(second.reflection).not.toBeNull()
  })

  it('被纠正过的记忆不会主动再提，但问起时还在', () => {
    const core = new CompanionCore({ now: () => 0 })
    core.onUserMessage('我住在重庆')

    const context = core.onUserMessage('重庆')
    const target = context.memories[0]
    expect(target).toBeDefined()
    if (target === undefined) return

    // 纠正一次之后，这条记忆会退到「不问不说」的档位。
    core.noteMemoryReaction(target.assertion.id, 'corrected')
    expect(core.onUserMessage('重庆').memories).toHaveLength(0)

    const asked = core.assertions.recall('重庆', {
      allowPolicies: ['direct', 'soft_echo', 'tone_only', 'avoid_unless_asked']
    })
    expect(asked.some((item) => item.assertion.id === target.assertion.id)).toBe(true)
  })
})

describe('陪伴核心：持久化', () => {
  it('存盘再读回来，心情和记住的事都还在', () => {
    const first = new CompanionCore({ now: () => 0 })
    first.onUserMessage('我住在重庆')
    first.mood.apply('praised', 1)

    const dump = JSON.parse(JSON.stringify(first.toJSON())) as unknown
    const restored = CompanionCore.fromJSON(dump, { now: () => 0 })

    expect(restored.mood.snapshot().valence).toBeCloseTo(first.mood.snapshot().valence, 5)
    expect(restored.assertions.live().length).toBe(first.assertions.live().length)
    expect(restored.onUserMessage('重庆').memoryNote).toContain('重庆')
  })

  it('坏数据只丢坏的那部分，不会整个崩掉', () => {
    const core = CompanionCore.fromJSON(
      { version: 1, mood: 'not-an-object', assertions: 42, reflection: null },
      { now: () => 0 }
    )

    expect(core.mood.snapshot().valence).toBeGreaterThanOrEqual(-1)
    expect(core.assertions.live()).toHaveLength(0)
    expect(core.onUserMessage('你好').emoji.length).toBeGreaterThan(0)
  })

  it('最近用过的表情也会一起恢复', () => {
    const first = new CompanionCore({ now: () => 0 })
    first.onAssistantReply('好耶', 'awesome')

    const restored = CompanionCore.fromJSON(JSON.parse(JSON.stringify(first.toJSON())), {
      now: () => 0
    })
    expect(restored.recentEmoji).toEqual(['awesome'])
  })
})
