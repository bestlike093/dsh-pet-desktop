import { describe, expect, it } from 'vitest'

import {
  DEFAULT_EMOJI_CATALOG,
  inferScene,
  pickEmoji
} from '../emojiPicker.js'
import type { EmojiEntry } from '../emojiPicker.js'

describe('表情选择', () => {
  it('目录里每个 id 唯一，且都指向 .png', () => {
    const ids = DEFAULT_EMOJI_CATALOG.map((item) => item.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(DEFAULT_EMOJI_CATALOG.every((item) => item.file.endsWith('.png'))).toBe(true)
  })

  it('开心时首选就是开心类表情', () => {
    const picked = pickEmoji({ emotion: 'happy', scene: 'praise' })

    expect(picked.length).toBeGreaterThan(0)
    expect(picked[0]?.entry.emotions).toContain('happy')
  })

  it('刚用过的图会被压下去，除非只剩它合适', () => {
    const recent = ['awesome', 'awesome', 'awesome']
    const fresh = pickEmoji({ emotion: 'happy', scene: 'praise', recentIds: [] })
    const afterUse = pickEmoji({ emotion: 'happy', scene: 'praise', recentIds: recent })

    const freshScore = fresh.find((item) => item.entry.id === 'awesome')?.score ?? 0
    const usedScore = afterUse.find((item) => item.entry.id === 'awesome')?.score ?? 0

    expect(usedScore).toBeLessThan(freshScore)
  })

  it('低唤醒时高亢奋的图会掉分，哪怕情绪正好对上', () => {
    const catalog: readonly EmojiEntry[] = DEFAULT_EMOJI_CATALOG
    const calm = pickEmoji(
      { emotion: 'excited', mood: { valence: 0.2, arousal: 0.1, tension: 0.2 } },
      { catalog }
    )
    const lively = pickEmoji(
      { emotion: 'excited', mood: { valence: 0.6, arousal: 0.85, tension: 0.2 } },
      { catalog }
    )

    const calmScore = calm.find((item) => item.entry.id === 'hellyeah')?.score ?? 0
    const livelyScore = lively.find((item) => item.entry.id === 'hellyeah')?.score ?? 0

    expect(calmScore).toBeLessThan(livelyScore)
  })

  it('分数低于阈值时不返回，用来表达「这次不发图」', () => {
    const picked = pickEmoji({ emotion: 'angry', scene: 'meal' }, { floor: 0.95 })
    expect(picked).toHaveLength(0)
  })

  it('结果最多返回 limit 条，且按分数降序', () => {
    const picked = pickEmoji({ emotion: 'happy' }, { limit: 3 })

    expect(picked.length).toBeLessThanOrEqual(3)
    for (let i = 1; i < picked.length; i += 1) {
      expect(picked[i - 1]?.score ?? 0).toBeGreaterThanOrEqual(picked[i]?.score ?? 0)
    }
  })

  it('按时间推断场景，深夜和早饭不一样', () => {
    expect(inferScene('happy', 7)).toBe('morning')
    expect(inferScene('happy', 12)).toBe('meal')
    expect(inferScene('tired', 23)).toBe('night')
    expect(inferScene('neutral', 15)).toBeUndefined()
  })
})
