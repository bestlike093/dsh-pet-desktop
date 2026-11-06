import { describe, expect, it } from 'vitest'

import { OpeningLedger } from '../openingLedger.js'

const T0 = new Date(2026, 10, 6, 10, 0, 0).getTime()
const MINUTE = 60_000
const HOUR = 60 * MINUTE

/** 可控时钟：账本自己不读墙钟，测试也不该依赖真实时间。 */
function clockAt(start: number) {
  let current = start
  return {
    now: () => current,
    set: (value: number) => {
      current = value
    },
    advance: (ms: number) => {
      current += ms
    }
  }
}

describe('主动开口账本：记账与节奏', () => {
  it('初始状态下今天没说过话，节奏不加倍', () => {
    const clock = clockAt(T0)
    const ledger = new OpeningLedger({ now: clock.now })
    const pacing = ledger.pacing()

    expect(pacing.spokenToday).toBe(0)
    expect(pacing.lastSpokenAt).toBe(0)
    expect(pacing.intervalScale).toBe(1)
    expect(pacing.blockedReason).toBeNull()
    expect(pacing.minutesSinceLast).toBeNull()
  })

  it('真正开口后计入今天，并记下上次时间', () => {
    const clock = clockAt(T0)
    const ledger = new OpeningLedger({ now: clock.now })

    ledger.spoken('loop', 'loop', 'loop:abc')
    clock.advance(35 * MINUTE)
    const pacing = ledger.pacing()

    expect(pacing.spokenToday).toBe(1)
    expect(pacing.lastSpokenAt).toBe(T0)
    expect(pacing.minutesSinceLast).toBe(35)
    expect(pacing.unansweredStreak).toBe(1)
    expect(pacing.intervalScale).toBe(1)
  })

  it('连续开口没人接话时，间隔逐级拉长', () => {
    const clock = clockAt(T0)
    const ledger = new OpeningLedger({ now: clock.now })

    ledger.spoken('loop', 'a', 'loop:a')
    ledger.spoken('loop', 'b', 'loop:b')
    expect(ledger.pacing().intervalScale).toBe(1.5)

    ledger.spoken('loop', 'c', 'loop:c')
    expect(ledger.pacing().intervalScale).toBe(2)

    ledger.spoken('loop', 'd', 'loop:d')
    ledger.spoken('loop', 'e', 'loop:e')
    expect(ledger.pacing().intervalScale).toBe(2.5)
  })

  it('用户接话后，连续未回应计数清零', () => {
    const clock = clockAt(T0)
    const ledger = new OpeningLedger({ now: clock.now })

    ledger.spoken('loop', 'a', 'loop:a')
    ledger.spoken('loop', 'b', 'loop:b')
    ledger.spoken('loop', 'c', 'loop:c')
    expect(ledger.pacing().intervalScale).toBe(2)

    ledger.userReplied()
    const pacing = ledger.pacing()
    expect(pacing.unansweredStreak).toBe(0)
    expect(pacing.intervalScale).toBe(1)
    // 今天说过的次数不会被用户回话抹掉。
    expect(pacing.spokenToday).toBe(3)
  })

  it('跨天只重置今天次数，上次开口时间保留', () => {
    const clock = clockAt(T0)
    const ledger = new OpeningLedger({ now: clock.now })
    ledger.spoken('loop', 'a', 'loop:a')

    clock.set(new Date(2026, 10, 7, 0, 10, 0).getTime())
    const pacing = ledger.pacing()

    expect(pacing.spokenToday).toBe(0)
    expect(pacing.lastSpokenAt).toBe(T0)
    expect(pacing.blockedReason).toBeNull()
  })

  it('达到每日上限后不再放行', () => {
    const clock = clockAt(T0)
    const ledger = new OpeningLedger({ now: clock.now, dailyLimit: 2 })

    expect(ledger.allows('loop', 'a', 'loop:a').allowed).toBe(true)
    ledger.spoken('loop', 'a', 'loop:a')
    ledger.spoken('loop', 'b', 'loop:b')

    expect(ledger.pacing().blockedReason).toBe('daily_limit')
    expect(ledger.allows('loop', 'c', 'loop:c')).toEqual({ allowed: false, reason: 'daily_limit' })
  })

  it('同一方向在窗口内不重复，换个方向可以放行', () => {
    const clock = clockAt(T0)
    const ledger = new OpeningLedger({ now: clock.now })

    ledger.spoken('loop', '还没聊完的事', 'loop:还没聊完的事')
    expect(ledger.allows('loop', '还没聊完的事', 'loop:还没聊完的事').allowed).toBe(false)
    expect(ledger.allows('loop', '另一件事', 'loop:另一件事').allowed).toBe(true)

    // 过了重复窗口，同一个方向可以再提。
    clock.advance(7 * HOUR)
    expect(ledger.allows('loop', '还没聊完的事', 'loop:还没聊完的事').allowed).toBe(true)
  })

  it('节目单段不按指纹拦，交给认领记录去重', () => {
    const clock = clockAt(T0)
    const ledger = new OpeningLedger({ now: clock.now })

    ledger.spoken('agenda', 'agenda:work', 'agenda:s1')
    expect(ledger.allows('agenda', 'agenda:work', 'agenda:s1').allowed).toBe(true)
  })

  it('生成失败只留记录，不计入今天也不进入冷却', () => {
    const clock = clockAt(T0)
    const ledger = new OpeningLedger({ now: clock.now })

    ledger.failed('loop', 'a', 'loop:a')
    const pacing = ledger.pacing()

    expect(pacing.spokenToday).toBe(0)
    expect(pacing.lastSpokenAt).toBe(0)
    expect(ledger.allows('loop', 'a', 'loop:a').allowed).toBe(true)
  })

  it('序列化后能读回同样的节奏，坏数据退回空账本', () => {
    const clock = clockAt(T0)
    const ledger = new OpeningLedger({ now: clock.now })
    ledger.spoken('loop', 'a', 'loop:a')
    ledger.spoken('loop', 'b', 'loop:b')

    const restored = OpeningLedger.fromJSON(ledger.toJSON(), { now: clock.now })
    expect(restored.pacing().spokenToday).toBe(2)
    expect(restored.pacing().lastSpokenAt).toBe(T0)
    expect(restored.pacing().unansweredStreak).toBe(2)

    const broken = OpeningLedger.fromJSON({ records: '不是数组', spokenToday: -3 }, { now: clock.now })
    expect(broken.pacing().spokenToday).toBe(0)
    expect(broken.pacing().lastSpokenAt).toBe(0)
  })

  it('给提示词的节奏提醒只在今天开口过时出现', () => {
    const clock = clockAt(T0)
    const ledger = new OpeningLedger({ now: clock.now })
    expect(ledger.describeForPrompt()).toBe('')

    ledger.spoken('loop', '没聊完的事', 'loop:x')
    const note = ledger.describeForPrompt()
    expect(note).toContain('今天你已经主动开口 1 次')
    expect(note).toContain('没聊完的事')
  })

  it('QQ 群插话只共享日预算，不推高未回应降速', () => {
    const clock = clockAt(T0)
    const ledger = new OpeningLedger({ now: clock.now, dailyLimit: 3 })

    ledger.spoken('loop', '没聊完的事', 'loop:x')
    const before = ledger.pacing()

    ledger.spokenShared('qq:group:g1:name_only')
    const after = ledger.pacing()

    expect(after.spokenToday).toBe(before.spokenToday + 1)
    // 群里的沉默不算进桌面端的未回应降速
    expect(after.unansweredStreak).toBe(before.unansweredStreak)
    // 桌面自己的上次开口时间也不被群消息改写
    expect(after.lastSpokenAt).toBe(before.lastSpokenAt)
    expect(ledger.allowsShared('qq:group:g1:name_only')).toEqual({
      allowed: false,
      reason: 'duplicate'
    })
  })

  it('群插话与桌面一起耗尽日预算后，两边都不再放行', () => {
    const clock = clockAt(T0)
    const ledger = new OpeningLedger({ now: clock.now, dailyLimit: 1 })

    ledger.spokenShared('qq:group:g1:name_only')

    expect(ledger.allowsShared('qq:group:g1:topic_match')).toEqual({
      allowed: false,
      reason: 'daily_limit'
    })
    expect(ledger.allows('loop', '没聊完的事', 'loop:x')).toEqual({
      allowed: false,
      reason: 'daily_limit'
    })
  })
})

describe('主动开口账本：好感分层', () => {
  it('刚认识（好感 0）保持默认分寸，不被当成疏远', () => {
    const clock = clockAt(T0)
    const ledger = new OpeningLedger({ now: clock.now, favor: () => 0 })

    const pacing = ledger.pacing()
    expect(pacing.dailyLimit).toBe(8)
    expect(pacing.favorScale).toBe(1)
  })

  it('好感高时多给机会，间隔也更短', () => {
    const clock = clockAt(T0)
    const ledger = new OpeningLedger({ now: clock.now, favor: () => 88 })

    const pacing = ledger.pacing()
    expect(pacing.dailyLimit).toBe(11)
    expect(pacing.favorScale).toBeCloseTo(0.7)
  })

  it('明确疏远时日上限收紧，并且真的拦住', () => {
    const clock = clockAt(T0)
    const ledger = new OpeningLedger({ now: clock.now, dailyLimit: 8, favor: () => 12 })

    expect(ledger.pacing().dailyLimit).toBe(6)
    expect(ledger.pacing().favorScale).toBeCloseTo(1.3)

    for (let index = 0; index < 6; index += 1) {
      expect(ledger.allows('loop', `事 ${index}`, `loop:${index}`).allowed).toBe(true)
      ledger.spoken('loop', `事 ${index}`, `loop:${index}`)
    }
    expect(ledger.allows('loop', '第七件', 'loop:7')).toEqual({
      allowed: false,
      reason: 'daily_limit'
    })
  })

  it('再疏远也至少留一次机会，不会彻底不开口', () => {
    const clock = clockAt(T0)
    const ledger = new OpeningLedger({ now: clock.now, dailyLimit: 1, favor: () => 5 })

    expect(ledger.pacing().dailyLimit).toBe(1)
    expect(ledger.allows('loop', '只想问一句', 'loop:only').allowed).toBe(true)
  })
})
