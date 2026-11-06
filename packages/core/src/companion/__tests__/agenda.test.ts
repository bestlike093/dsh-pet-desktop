import { describe, expect, it } from 'vitest'
import {
  AgendaClaims,
  DEFAULT_SEGMENTS,
  MAX_SEGMENTS,
  MINUTES_PER_DAY,
  buildPlan,
  carryOver,
  dateKey,
  defaultPlan,
  fillGaps,
  formatMinute,
  isPlanFor,
  minuteOfDay,
  nextSegment,
  normalizeSegments,
  planNote,
  rescheduleAfter,
  segmentAt,
  validateSegments
} from '../agenda.js'
import type { AgendaSegment } from '../agenda.js'

function at(hour: number, minute = 0): number {
  return new Date(2026, 10, 5, hour, minute, 0, 0).getTime()
}

const rawDay = [
  { id: 'sleep', startMinute: 0, endMinute: 420, title: '睡觉', kind: 'sleep' },
  { id: 'work', startMinute: 540, endMinute: 720, title: '写东西', kind: 'work' }
]

describe('agenda 校验', () => {
  it('空节目单会被指出来', () => {
    const issues = validateSegments([])
    expect(issues.some((issue) => issue.field === 'segments')).toBe(true)
  })

  it('重叠、越界、太短、空标题都能一次报完', () => {
    const broken: AgendaSegment[] = [
      { id: 'a', startMinute: 0, endMinute: 600, title: '一', kind: 'work' },
      { id: 'b', startMinute: 500, endMinute: 700, title: '二', kind: 'work' },
      { id: 'c', startMinute: 1430, endMinute: 1500, title: '', kind: 'other' },
      { id: 'd', startMinute: 900, endMinute: 905, title: '四', kind: 'rest' }
    ]
    const messages = validateSegments(broken).map((issue) => issue.message).join('\n')
    expect(messages).toContain('重叠')
    expect(messages).toContain('超出一整天')
    expect(messages).toContain('没有标题')
    expect(messages).toContain('少于')
  })

  it('段数超过上限会报', () => {
    const many: AgendaSegment[] = Array.from({ length: MAX_SEGMENTS + 1 }, (_, index) => ({
      id: `s${index}`,
      startMinute: index * 30,
      endMinute: index * 30 + 30,
      title: '段',
      kind: 'other' as const
    }))
    expect(validateSegments(many).some((issue) => issue.field === 'segments')).toBe(true)
  })

  it('合法的一天没有问题', () => {
    expect(validateSegments(DEFAULT_SEGMENTS)).toEqual([])
  })
})

describe('agenda 清洗', () => {
  it('丢掉非法段，按时间排序', () => {
    const segments = normalizeSegments(
      [
        { id: 'late', startMinute: 900, endMinute: 1000, title: '下午', kind: 'work' },
        { id: 'bad', startMinute: 1200, endMinute: 1100, title: '倒着的', kind: 'work' },
        { id: 'no-title', startMinute: 300, endMinute: 400, title: '   ', kind: 'rest' },
        { id: 'early', startMinute: 600, endMinute: 700, title: '上午', kind: 'study' }
      ],
      { fillGaps: false }
    )
    expect(segments.map((segment) => segment.id)).toEqual(['early', 'late'])
    expect(segments[0]?.startMinute).toBe(600)
  })

  it('重叠时保留先出现的那一段', () => {
    const segments = normalizeSegments([
      { id: 'first', startMinute: 600, endMinute: 720, title: '先写的', kind: 'work' },
      { id: 'second', startMinute: 660, endMinute: 780, title: '后写的', kind: 'rest' }
    ])
    expect(segments.some((segment) => segment.id === 'first')).toBe(true)
    expect(segments.some((segment) => segment.id === 'second')).toBe(false)
  })

  it('重复 id 会自动区分', () => {
    const segments = normalizeSegments([
      { id: 'same', startMinute: 0, endMinute: 60, title: '一', kind: 'other' },
      { id: 'same', startMinute: 120, endMinute: 180, title: '二', kind: 'other' }
    ])
    expect(new Set(segments.map((segment) => segment.id)).size).toBe(segments.length)
  })

  it('默认补齐缝隙，时间线连续', () => {
    const segments = normalizeSegments(rawDay)
    expect(segments[0]?.startMinute).toBe(0)
    expect(segments.at(-1)?.endMinute).toBe(MINUTES_PER_DAY)
    for (let index = 1; index < segments.length; index += 1) {
      expect(segments[index]?.startMinute).toBe(segments[index - 1]?.endMinute)
    }
  })

  it('可以关掉补缝隙', () => {
    const segments = normalizeSegments(rawDay, { fillGaps: false })
    expect(segments).toHaveLength(2)
  })

  it('全部不合法时返回空，交给调用方兜底', () => {
    expect(normalizeSegments([{ title: '' }, 42, null])).toEqual([])
    expect(fillGaps([])).toEqual([])
  })
})

describe('agenda 建单', () => {
  it('模型输出可用时采用它', () => {
    const plan = buildPlan(rawDay, { now: at(13, 30) })
    expect(plan.source).toBe('model')
    expect(plan.date).toBe('2026-11-05')
  })

  it('模型什么都没给时退回内置一天，不留白', () => {
    const plan = buildPlan([], { now: at(13, 30) })
    expect(plan.source).toBe('default')
    expect(plan.segments.length).toBe(DEFAULT_SEGMENTS.length)
    expect(validateSegments(plan.segments)).toEqual([])
  })

  it('沿用上一份结构时只换日期', () => {
    const previous = buildPlan(rawDay, { now: at(13, 30) })
    const next = carryOver(previous, new Date(2026, 10, 6, 9, 0, 0, 0).getTime())
    expect(next.date).toBe('2026-11-06')
    expect(next.source).toBe('carryover')
    expect(next.segments.map((segment) => segment.title)).toEqual(
      previous.segments.map((segment) => segment.title)
    )
    expect(next.segments[0]?.id.startsWith('2026-11-06-')).toBe(true)
  })

  it('判断是不是今天的单', () => {
    const plan = defaultPlan(at(9))
    expect(isPlanFor(plan, at(23))).toBe(true)
    expect(isPlanFor(plan, new Date(2026, 10, 6, 9, 0, 0, 0).getTime())).toBe(false)
  })
})

describe('agenda 查询', () => {
  const plan = buildPlan(rawDay, { now: at(13, 30) })

  it('开始分钟包含，结束分钟不包含', () => {
    expect(segmentAt(plan, at(9, 0))?.id).toBe('work')
    expect(segmentAt(plan, at(11, 59))?.id).toBe('work')
    expect(segmentAt(plan, at(12, 0))?.id).not.toBe('work')
  })

  it('能给出下一段', () => {
    expect(nextSegment(plan, at(9, 30))?.id).not.toBeNull()
    expect(nextSegment(plan, at(23, 59))).toBeNull()
  })

  it('提示词只写现在和接下来', () => {
    const note = planNote(plan, at(9, 30))
    expect(note).toContain('你此刻正在做')
    expect(note).toContain('接下来是')
    expect(note.split('\n').length).toBeLessThanOrEqual(3)
  })

  it('时间格式化补零', () => {
    expect(formatMinute(0)).toBe('00:00')
    expect(formatMinute(9 * 60 + 5)).toBe('09:05')
    expect(formatMinute(MINUTES_PER_DAY)).toBe('24:00')
  })

  it('日期与分钟按本地时间算', () => {
    expect(dateKey(at(0, 0))).toBe('2026-11-05')
    expect(minuteOfDay(at(18, 30))).toBe(18 * 60 + 30)
  })
})

describe('AgendaClaims', () => {
  it('同一段一天只认领一次', () => {
    const plan = buildPlan(rawDay, { now: at(9, 30) })
    const claims = new AgendaClaims()
    expect(claims.claim(plan, at(9, 30))?.id).toBe('work')
    expect(claims.claim(plan, at(9, 40))).toBeNull()
    expect(claims.claim(plan, at(10, 0))).toBeNull()
  })

  it('放弃认领后可以重新尝试', () => {
    const plan = buildPlan(rawDay, { now: at(9, 30) })
    const claims = new AgendaClaims()
    claims.claim(plan, at(9, 30))
    claims.release(plan.date, 'work')
    expect(claims.claim(plan, at(9, 35))?.id).toBe('work')
  })

  it('跨天后清掉旧记录', () => {
    const plan = buildPlan(rawDay, { now: at(9, 30) })
    const claims = new AgendaClaims()
    claims.claim(plan, at(9, 30))
    claims.prune(at(10, 0))
    expect(claims.size).toBe(1)
    claims.prune(new Date(2026, 10, 6, 9, 0, 0, 0).getTime())
    expect(claims.size).toBe(0)
  })

  it('存盘再读回，认领状态还在', () => {
    const plan = buildPlan(rawDay, { now: at(9, 30) })
    const claims = new AgendaClaims()
    claims.claim(plan, at(9, 30))
    const restored = AgendaClaims.fromJSON(JSON.parse(JSON.stringify(claims.toJSON())) as unknown)
    expect(restored.isClaimed(plan.date, 'work')).toBe(true)
    expect(restored.claim(plan, at(9, 35))).toBeNull()
  })

  it('脏数据不会带进来', () => {
    const restored = AgendaClaims.fromJSON({ version: 1, claims: { '2026-11-05#a': 'x' } })
    expect(restored.size).toBe(0)
  })
})

describe('被打断后的日程重排', () => {
  it('把被打断的时间记成陪聊，后面的安排整体顺延', () => {
    const plan = defaultPlan(at(10, 0))
    const result = rescheduleAfter(plan, { now: at(10, 0), delayMinutes: 30 })

    expect(result.changed).toBe(true)
    expect(result.shiftedMinutes).toBe(30)
    const chat = result.plan.segments.find((segment) => segment.id === 'focus-chat')
    expect(chat).toMatchObject({ startMinute: 600, endMinute: 630, kind: 'leisure' })
    const focus = result.plan.segments.find((segment) => segment.id === 'focus')
    expect(focus).toMatchObject({ startMinute: 630, endMinute: 750 })

    // 时间线仍然连续，并且覆盖到 24:00。
    let cursor = 0
    for (const segment of result.plan.segments) {
      expect(segment.startMinute).toBe(cursor)
      cursor = segment.endMinute
    }
    expect(cursor).toBe(MINUTES_PER_DAY)
  })

  it('压缩先动闲着的时间，晚饭和睡觉尽量不动', () => {
    const plan = defaultPlan(at(10, 0))
    const result = rescheduleAfter(plan, { now: at(10, 0), delayMinutes: 60 })
    const byId = new Map(result.plan.segments.map((segment) => [segment.id, segment]))

    expect(byId.get('dinner')).toMatchObject({ startMinute: 1140, endMinute: 1200 })
    expect(byId.get('sleep')).toMatchObject({ startMinute: 0, endMinute: 420 })
    // 60 分钟全从「闲下来」里扣，原本三小时变两小时。
    expect(byId.get('evening')).toMatchObject({ startMinute: 1200, endMinute: 1320 })
  })

  it('正在睡觉、没被打断、压不出时间时都不改', () => {
    const plan = defaultPlan(at(3, 0))
    expect(rescheduleAfter(plan, { now: at(3, 0), delayMinutes: 30 })).toMatchObject({
      changed: false,
      reason: 'sleeping'
    })
    expect(rescheduleAfter(plan, { now: at(3, 0), delayMinutes: 0 })).toMatchObject({
      changed: false,
      reason: 'no-delay'
    })

    const late = defaultPlan(at(22, 40))
    expect(rescheduleAfter(late, { now: at(22, 40), delayMinutes: 200 })).toMatchObject({
      changed: false,
      reason: 'no-room'
    })
  })

  it('陪完之后她回到手头的事，而不是直接跳到下一段', () => {
    const plan = defaultPlan(at(10, 0))
    const result = rescheduleAfter(plan, { now: at(10, 0), delayMinutes: 20 })
    expect(segmentAt(result.plan, at(10, 20))?.id).toBe('focus')
  })
})
