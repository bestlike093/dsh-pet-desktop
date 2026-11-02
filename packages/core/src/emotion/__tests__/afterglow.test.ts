import { describe, expect, it } from 'vitest'
import {
  DEFAULT_AFTERGLOW_HALF_LIFE_MS,
  EmotionAfterglow,
  decayByHalfLife
} from '../afterglow.js'

function fixedClock(start: number) {
  let now = start
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms
    }
  }
}

describe('情绪余波：半衰期衰减（E1）', () => {
  it('经过一个半衰期，数值减半', () => {
    expect(decayByHalfLife(0.8, DEFAULT_AFTERGLOW_HALF_LIFE_MS, DEFAULT_AFTERGLOW_HALF_LIFE_MS)).toBeCloseTo(0.4, 6)
    expect(decayByHalfLife(-0.8, DEFAULT_AFTERGLOW_HALF_LIFE_MS, DEFAULT_AFTERGLOW_HALF_LIFE_MS)).toBeCloseTo(-0.4, 6)
  })

  it('时间没有前进时不衰减', () => {
    expect(decayByHalfLife(0.5, 0, 1000)).toBe(0.5)
  })

  it('一次满权重刺激直接到达目标值，读取时按半衰期回落', () => {
    const clock = fixedClock(1000)
    const afterglow = new EmotionAfterglow({
      now: clock.now,
      enabled: true,
      halfLifeMs: 1000,
      weight: 1
    })

    expect(afterglow.impulse({ valence: 1, arousal: 1 })).toMatchObject({
      valence: 1,
      arousal: 1
    })

    clock.advance(1000)
    expect(afterglow.snapshot().valence).toBeCloseTo(0.5, 6)
    expect(afterglow.snapshot().arousal).toBeCloseTo(0.5, 6)
  })

  it('饱和边界：刺激值超出范围会被夹住', () => {
    const clock = fixedClock(0)
    const afterglow = new EmotionAfterglow({ now: clock.now, enabled: true, weight: 1 })

    const snapshot = afterglow.impulse({ valence: 9, arousal: -3 })

    expect(snapshot.valence).toBe(1)
    expect(snapshot.arousal).toBe(0)
  })

  it('刺激按权重靠近目标，不会一步跳满', () => {
    const clock = fixedClock(0)
    const afterglow = new EmotionAfterglow({ now: clock.now, enabled: true, weight: 0.35 })

    const snapshot = afterglow.impulse({ valence: 1, arousal: 1 })

    expect(snapshot.valence).toBeCloseTo(0.35, 6)
    expect(snapshot.arousal).toBeCloseTo(0.35, 6)
  })

  it('长时间衰减后低于阈值归零', () => {
    const clock = fixedClock(0)
    const afterglow = new EmotionAfterglow({
      now: clock.now,
      enabled: true,
      halfLifeMs: 1000,
      weight: 1
    })

    afterglow.impulse({ valence: 0.02, arousal: 0 })
    clock.advance(10_000)

    expect(afterglow.snapshot().valence).toBe(0)
  })

  it('关闭时不生效，snapshot 恒为零', () => {
    const clock = fixedClock(0)
    const afterglow = new EmotionAfterglow({ now: clock.now, enabled: false })

    expect(afterglow.impulse({ valence: 1, arousal: 1 })).toMatchObject({
      valence: 0,
      arousal: 0
    })
  })

  it('关闭会清掉已有余波', () => {
    const clock = fixedClock(0)
    const afterglow = new EmotionAfterglow({ now: clock.now, enabled: true, weight: 1 })

    afterglow.impulse({ valence: 1, arousal: 1 })
    afterglow.setEnabled(false)

    expect(afterglow.snapshot().valence).toBe(0)
  })
})
