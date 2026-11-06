import { describe, expect, it } from 'vitest'
import { buildPlan, type DayPlan } from '../agenda.js'
import {
  DEFAULT_ABSENCE_AFTER_MS,
  DEFAULT_LOOP_MIN_AGE_MS,
  DEFAULT_THOUGHT_MIN_AGE_MS,
  candidatesAt,
  pickCandidate,
  type CandidateInput
} from '../candidates.js'

const HOUR = 60 * 60_000
const DAY = 24 * HOUR

/** 2026-11-05 09:10 本地时间。 */
const AT_0910 = new Date(2026, 10, 5, 9, 10).getTime()

function workPlan(now = AT_0910): DayPlan {
  return buildPlan(
    [
      { startMinute: 0, endMinute: 7 * 60, title: '睡觉', kind: 'sleep' },
      { startMinute: 7 * 60, endMinute: 9 * 60, title: '洗漱', kind: 'chore' },
      { startMinute: 9 * 60, endMinute: 12 * 60, title: '写代码', kind: 'work', memo: '在做桌面宠物' },
      { startMinute: 12 * 60, endMinute: 13 * 60, title: '午饭', kind: 'meal' },
      { startMinute: 13 * 60, endMinute: 24 * 60, title: '留白', kind: 'rest' }
    ],
    { now, source: 'model' }
  )
}

function base(overrides: Partial<CandidateInput> = {}): CandidateInput {
  return { now: AT_0910, agenda: workPlan(), ...overrides }
}

describe('candidatesAt 的闸门', () => {
  it('睡着时一条都不给', () => {
    expect(candidatesAt(base({ asleep: true }))).toEqual([])
  })

  it('免打扰时段一条都不给', () => {
    expect(candidatesAt(base({ quiet: true }))).toEqual([])
  })

  it('冷却期没到就闭嘴', () => {
    expect(candidatesAt(base({ cooldownUntil: AT_0910 + 5 * 60_000 }))).toEqual([])
  })

  it('冷却期已过可以恢复', () => {
    expect(candidatesAt(base({ cooldownUntil: AT_0910 - 1 })).length).toBeGreaterThan(0)
  })
})

describe('agenda 候选', () => {
  it('刚进入这一段时给一条', () => {
    const found = candidatesAt(base())
    const agenda = found.find((item) => item.kind === 'agenda')
    expect(agenda).toBeDefined()
    expect(agenda?.segmentId).toBe(workPlan().segments.find((s) => s.title === '写代码')?.id)
    expect(agenda?.note).toContain('写代码')
    expect(agenda?.note).toContain('在做桌面宠物')
  })

  it('进入这一段太久就不再补一句', () => {
    const later = new Date(2026, 10, 5, 10, 30).getTime()
    const found = candidatesAt(base({ now: later }))
    expect(found.some((item) => item.kind === 'agenda')).toBe(false)
  })

  it('睡眠段不触发', () => {
    const earlyMorning = new Date(2026, 10, 5, 3, 10).getTime()
    const found = candidatesAt(base({ now: earlyMorning }))
    expect(found.some((item) => item.kind === 'agenda')).toBe(false)
  })

  it('已经认领过的段不再给', () => {
    const segment = workPlan().segments.find((s) => s.title === '写代码')
    const found = candidatesAt(base({ claimedSegmentIds: [segment?.id ?? ''] }))
    expect(found.some((item) => item.kind === 'agenda')).toBe(false)
  })

  it('累了就不挑日常话题，但没说完的事还会问', () => {
    const loop = { id: 'loop-1', text: '晚点告诉你结果', createdAt: AT_0910 - DEFAULT_LOOP_MIN_AGE_MS - 1 }
    const found = candidatesAt(base({ tired: true, loop }))

    expect(found.some((item) => item.kind === 'agenda')).toBe(false)
    expect(found.some((item) => item.kind === 'loop')).toBe(true)
  })

  it('歇过来了日程话题会恢复', () => {
    const found = candidatesAt(base({ tired: false }))
    expect(found.some((item) => item.kind === 'agenda')).toBe(true)
  })
})

describe('thought 候选', () => {
  const thought = {
    id: 't-1',
    text: '想问问他昨天说的那个结果',
    createdAt: AT_0910 - DEFAULT_THOUGHT_MIN_AGE_MS - 1,
    weight: 0.8
  }

  it('放够时间就给，并带上念头 id 和原意', () => {
    const found = candidatesAt(base({ thought }))
    const item = found.find((entry) => entry.kind === 'thought')
    expect(item).toBeDefined()
    expect(item?.thoughtId).toBe('t-1')
    expect(item?.note).toContain('昨天说的那个结果')
    expect(item?.segmentId).toBeNull()
  })

  it('刚攒下的念头先放一会儿', () => {
    const fresh = { ...thought, createdAt: AT_0910 - 60_000 }
    const found = candidatesAt(base({ thought: fresh }))
    expect(found.some((entry) => entry.kind === 'thought')).toBe(false)
  })

  it('优先于很久没联系和日程', () => {
    const picked = pickCandidate(
      base({ thought, lastUserAt: AT_0910 - DEFAULT_ABSENCE_AFTER_MS - DAY })
    )
    expect(picked?.kind).toBe('thought')
  })

  it('累了也还能把攒着的话说出来', () => {
    const found = candidatesAt(base({ thought, tired: true }))
    expect(found.some((entry) => entry.kind === 'thought')).toBe(true)
  })

  it('安静或睡着时念头也不越过闸门', () => {
    expect(candidatesAt(base({ thought, quiet: true }))).toEqual([])
    expect(candidatesAt(base({ thought, asleep: true }))).toEqual([])
    expect(
      candidatesAt(base({ thought, cooldownUntil: AT_0910 + 5 * 60_000 }))
    ).toEqual([])
  })
})

describe('loop 候选', () => {
  it('刚留下的话头还不催', () => {
    const loop = { id: 'loop-1', text: '晚点告诉你结果', createdAt: AT_0910 - 5 * 60_000 }
    const found = candidatesAt(base({ loop }))
    expect(found.some((item) => item.kind === 'loop')).toBe(false)
  })

  it('放够了时间就给，并带上原话', () => {
    const loop = { id: 'loop-1', text: '晚点告诉你结果', createdAt: AT_0910 - DEFAULT_LOOP_MIN_AGE_MS - 1 }
    const found = candidatesAt(base({ loop }))
    const item = found.find((entry) => entry.kind === 'loop')
    expect(item).toBeDefined()
    expect(item?.note).toContain('晚点告诉你结果')
    expect(item?.segmentId).toBeNull()
  })
})

describe('absence 候选', () => {
  it('还没聊过不算很久没联系', () => {
    const found = candidatesAt(base({ lastUserAt: null }))
    expect(found.some((item) => item.kind === 'absence')).toBe(false)
  })

  it('超过阈值才提，并优先于其他理由', () => {
    const loop = { id: 'loop-1', text: '晚点告诉你结果', createdAt: AT_0910 - HOUR }
    const found = candidatesAt(
      base({ lastUserAt: AT_0910 - DEFAULT_ABSENCE_AFTER_MS - DAY, loop })
    )
    expect(found[0]?.kind).toBe('absence')
    expect(found[0]?.note).toContain('4 天')
  })
})

describe('pickCandidate', () => {
  it('多个理由时只取优先级最高的', () => {
    const loop = { id: 'loop-1', text: '晚点告诉你结果', createdAt: AT_0910 - HOUR }
    const picked = pickCandidate(
      base({ lastUserAt: AT_0910 - DEFAULT_ABSENCE_AFTER_MS - DAY, loop })
    )
    expect(picked?.kind).toBe('absence')
  })

  it('什么都没有就返回 null', () => {
    const picked = pickCandidate(base({ quiet: true }))
    expect(picked).toBeNull()
  })
})
