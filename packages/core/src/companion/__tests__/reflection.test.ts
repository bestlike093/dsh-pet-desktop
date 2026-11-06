import { describe, expect, it } from 'vitest'

import { loopDueAt, ReflectionEngine } from '../reflection.js'

const user = (content: string) => ({ role: 'user' as const, content })
const bot = (content: string) => ({ role: 'assistant' as const, content })

describe('反思：未完成的话头', () => {
  it('带时间词的表达会被记成话头', () => {
    let clock = 0
    const engine = new ReflectionEngine({ now: () => clock })

    engine.observe(user('明天要去面试，有点紧张'))
    const loops = engine.loops('open')

    expect(loops).toHaveLength(1)
    expect(loops[0]?.dueHint).toBe('明天')
  })

  it('「搞定了」会关掉最近一条话头，且只关一条', () => {
    let clock = 0
    const engine = new ReflectionEngine({ now: () => clock })

    engine.observe(user('明天要去面试'))
    clock = 100
    engine.observe(user('周末想去看展'))
    clock = 200
    engine.observe(user('面试搞定了'))

    const open = engine.loops('open')
    expect(open).toHaveLength(1)
    expect(open[0]?.text).toContain('周末')
  })

  it('超过七天自动过期，不会秋天再提起春天的事', () => {
    let clock = 0
    const engine = new ReflectionEngine({ now: () => clock })

    engine.observe(user('下次一起去爬山'))
    clock = 8 * 24 * 60 * 60_000

    expect(engine.expireLoops()).toBe(1)
    expect(engine.loops('open')).toHaveLength(0)
    expect(engine.loops('expired')).toHaveLength(1)
  })

  it('普通发言不会凭空造出话头', () => {
    const engine = new ReflectionEngine({ now: () => 0 })
    engine.observe(user('今天天气不错'))

    expect(engine.loops('open')).toHaveLength(0)
  })
})

describe('话头到期：别在当晚就问明天的事', () => {
  // 2026-11-06 是周五，晚上九点。
  const evening = new Date(2026, 10, 6, 21, 0, 0).getTime()
  const HOUR = 60 * 60_000

  it('「明天」落到第二天上午九点', () => {
    expect(loopDueAt('明天', evening)).toBe(new Date(2026, 10, 7, 9, 0, 0).getTime())
  })

  it('「后天」多等一天', () => {
    expect(loopDueAt('后天', evening)).toBe(new Date(2026, 10, 8, 9, 0, 0).getTime())
  })

  it('周五晚上说「周末」，就是周六上午十点', () => {
    expect(loopDueAt('周末', evening)).toBe(new Date(2026, 10, 7, 10, 0, 0).getTime())
  })

  it('「等我」「晚点」只等两小时，不拖到第二天', () => {
    expect(loopDueAt('晚点', evening)).toBe(evening + 2 * HOUR)
    expect(loopDueAt('等我', evening)).toBe(evening + 2 * HOUR)
  })

  it('「下次」「改天」「回头」给一天', () => {
    expect(loopDueAt('下次', evening)).toBe(evening + 24 * HOUR)
    expect(loopDueAt('改天', evening)).toBe(evening + 24 * HOUR)
    expect(loopDueAt('回头', evening)).toBe(evening + 24 * HOUR)
  })

  it('没有时间词就不设到期', () => {
    expect(loopDueAt(undefined, evening)).toBeUndefined()
    expect(loopDueAt('', evening)).toBeUndefined()
  })

  it('话头里会带上算好的到期时间', () => {
    const engine = new ReflectionEngine({ now: () => evening })
    engine.observe(user('明天要去面试'))

    expect(engine.loops('open')[0]?.dueAt).toBe(new Date(2026, 10, 7, 9, 0, 0).getTime())
  })
})

describe('反思：触发与产出', () => {
  it('轮数够了才反思，不是每句都写', () => {
    const engine = new ReflectionEngine({ now: () => 0, everyTurns: 3 })

    engine.observe(user('在吗'))
    expect(engine.shouldReflect()).toBe(false)

    engine.observe(bot('在的'))
    engine.observe(user('有点累'))
    expect(engine.shouldReflect()).toBe(true)
  })

  it('反思产出一句话，并把缓冲区清空', () => {
    const engine = new ReflectionEngine({ now: () => 0, everyTurns: 2 })
    engine.observe(user('今天开会开到很晚'))
    engine.observe(bot('辛苦了'))

    const reflection = engine.reflect()
    expect(reflection?.note).toContain('轮')
    expect(engine.shouldReflect()).toBe(false)

    // 同样两轮不会再次产出反思
    expect(engine.reflect()).toBeNull()
  })

  it('自省文本不包含任何内部字段名', () => {
    const engine = new ReflectionEngine({ now: () => 0, everyTurns: 1 })
    engine.observe(user('明天要早起'))

    const note = engine.reflect()?.note ?? ''
    expect(note).not.toMatch(/valence|arousal|tension|openLoops/)
  })

  it('可以注入自己的叙述器，但默认模板仍然可用', () => {
    const engine = new ReflectionEngine({
      now: () => 0,
      everyTurns: 1,
      narrator: () => '今天她说了很多，我记住了一件小事。'
    })
    engine.observe(user('今天说了很多'))

    expect(engine.reflect()?.note).toBe('今天她说了很多，我记住了一件小事。')
  })
})
