import { describe, expect, it } from 'vitest'

import {
  MOOD_BASELINE,
  MoodEngine,
  detectMoodSignals
} from '../mood.js'

describe('三维心情（陪伴层）', () => {
  it('默认从基线开始，不是从零点开始', () => {
    const engine = new MoodEngine({ now: () => 1_000 })
    const snapshot = engine.snapshot()

    expect(snapshot.valence).toBeCloseTo(MOOD_BASELINE.valence, 5)
    expect(snapshot.arousal).toBeCloseTo(MOOD_BASELINE.arousal, 5)
    expect(snapshot.tension).toBeCloseTo(MOOD_BASELINE.tension, 5)
    expect(snapshot.updatedAt).toBe(1_000)
  })

  it('被夸会抬高兴奋度，被冒犯会同时压低愉快度、抬高张力', () => {
    let clock = 0
    const engine = new MoodEngine({ now: () => clock })

    const praised = engine.apply('praised', 1)
    expect(praised.valence).toBeGreaterThan(MOOD_BASELINE.valence)
    expect(praised.tension).toBeLessThan(MOOD_BASELINE.tension)

    const before = engine.snapshot()
    const hurt = engine.apply('conflict', 1)
    expect(hurt.valence).toBeLessThan(before.valence)
    expect(hurt.tension).toBeGreaterThan(before.tension)

    // 从平静状态直接被打断，才会整片沉下来；刚被夸过时不会一秒钟翻脸。
    const fresh = new MoodEngine({ now: () => 0 })
    expect(fresh.toEmotionTag(fresh.apply('conflict', 1))).toBe('angry')
  })

  it('经过一个半衰期，偏离量恰好减半', () => {
    let clock = 0
    const halfLife = 60_000
    const engine = new MoodEngine({ now: () => clock, halfLifeMs: halfLife })

    const after = engine.apply('praised', 1)
    const delta = after.valence - MOOD_BASELINE.valence

    clock = halfLife
    const settled = engine.snapshot()

    expect(settled.valence - MOOD_BASELINE.valence).toBeCloseTo(delta / 2, 4)
  })

  it('反复刺激也不会越过上下界', () => {
    const engine = new MoodEngine({ now: () => 0 })
    for (let i = 0; i < 30; i += 1) engine.apply('conflict', 1)
    const snapshot = engine.snapshot()

    expect(snapshot.valence).toBeGreaterThanOrEqual(-1)
    expect(snapshot.tension).toBeLessThanOrEqual(1)
    expect(snapshot.arousal).toBeGreaterThanOrEqual(0)
  })

  it('存盘再读回，离线期间照样回归', () => {
    let clock = 0
    const engine = new MoodEngine({ now: () => clock, halfLifeMs: 10_000 })
    engine.apply('conflict', 1)

    const saved = engine.toJSON()
    clock = 5_000

    const restored = MoodEngine.fromJSON(saved, { now: () => clock, halfLifeMs: 10_000 })
    const snapshot = restored.snapshot()

    // 存盘时张力被抬高，离线 5 秒后应往基线退了一截，但仍高于基线。
    expect(snapshot.tension).toBeGreaterThan(MOOD_BASELINE.tension)
    expect(snapshot.tension).toBeLessThan(saved.tension)
  })

  it('坏数据退回基线，不抛错', () => {
    const engine = MoodEngine.fromJSON({ valence: 'oops', arousal: null }, { now: () => 0 })
    const snapshot = engine.snapshot()

    expect(snapshot.valence).toBeCloseTo(MOOD_BASELINE.valence, 5)
    expect(snapshot.arousal).toBeCloseTo(MOOD_BASELINE.arousal, 5)
  })

  it('从文本识别信号，认不出就返回空', () => {
    expect(detectMoodSignals('谢谢你，今天真的太好了').map((item) => item.kind)).toContain('praised')
    expect(detectMoodSignals('晚上吃什么呢')).toHaveLength(0)
  })

  it('心情描述里不出现任何数值', () => {
    const engine = new MoodEngine({ now: () => 0 })
    engine.apply('conflict', 1)

    expect(engine.describe()).not.toMatch(/\d/)
  })
})
