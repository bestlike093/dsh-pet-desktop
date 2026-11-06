import { describe, expect, it } from 'vitest'

import { AssertionStore, extractAssertions } from '../assertions.js'

describe('断言层：抽取与闸门', () => {
  it('抽出居住地这类单值属性', () => {
    const { candidates } = extractAssertions('我住在重庆，最近在找工作')
    const address = candidates.find((item) => item.attribute === '居住地')

    expect(address).toBeDefined()
    expect(address?.value).toBe('重庆')
    expect(address?.multiValued).toBe(false)
    expect(address?.evidence.length).toBeGreaterThan(0)
  })

  it('转述他人的话不进事实', () => {
    const { candidates, rejected } = extractAssertions('我同事说他也住在重庆')

    expect(candidates).toHaveLength(0)
    expect(rejected[0]?.reason).toBe('quoted_other')
  })

  it('角色扮演与假设不进事实', () => {
    const { rejected } = extractAssertions('假如我是医生，我会先看片')
    expect(rejected[0]?.reason).toBe('roleplay')
  })

  it('临时状态不进长期断言', () => {
    const { rejected } = extractAssertions('我今天好累')
    expect(rejected[0]?.reason).toBe('temporary')
  })

  it('同一句里的临时状态只丢自己，不连坐旁边的长期偏好', () => {
    const { candidates, rejected } = extractAssertions('我喜欢晚上写代码，最近有点累')

    expect(candidates.map((item) => `${item.attribute}=${item.value}`)).toContain(
      '喜欢=晚上写代码'
    )
    expect(rejected.some((item) => item.reason === 'temporary')).toBe(true)
  })

  it('转述只丢那一句，同段的自述仍然保留', () => {
    const { candidates } = extractAssertions('我同事说他住在重庆，我住在成都')

    expect(candidates.some((item) => item.attribute === '居住地' && item.value === '成都')).toBe(
      true
    )
  })

  it('未兑现的打算只算话头，不算事实', () => {
    const { rejected } = extractAssertions('我打算下个月学吉他')
    expect(rejected[0]?.reason).toBe('unfulfilled')
  })

  it('空文本被明确拒绝，而不是静默返回', () => {
    const { rejected } = extractAssertions('   ')
    expect(rejected[0]?.reason).toBe('empty')
  })
})

describe('断言层：写入与冲突', () => {
  it('单值属性改口后，旧值不再生效但保留在历史里', () => {
    let clock = 0
    const store = new AssertionStore({ now: () => clock })

    store.ingest('我住在重庆')
    clock = 1_000
    store.ingest('我住在成都')

    const live = store.live()
    expect(live).toHaveLength(1)
    expect(live[0]?.value).toBe('成都')

    // 旧值仍在 all() 里，供「你以前不是住重庆吗」这类提问使用
    expect(store.all().some((item) => item.value === '重庆')).toBe(true)
  })

  it('多值属性只增不替：喜欢咖啡和喜欢茶可以并存', () => {
    const store = new AssertionStore({ now: () => 0 })
    store.ingest('我很喜欢咖啡')
    store.ingest('我很喜欢喝茶')

    const likes = store.live().filter((item) => item.attribute === '喜欢')
    expect(likes).toHaveLength(2)
    expect(likes.map((item) => item.value)).toContain('咖啡')
    expect(likes.map((item) => item.value)).toContain('喝茶')
  })

  it('同一个值重复出现只累积证据，不产生副本', () => {
    const store = new AssertionStore({ now: () => 0 })
    store.ingest('我很喜欢咖啡')
    store.ingest('我还是很喜欢咖啡')

    const likes = store.live().filter((item) => item.attribute === '喜欢')
    expect(likes).toHaveLength(1)
    expect(likes[0]?.evidence.length).toBe(2)
  })

  it('没有出处的断言直接拒绝写入', () => {
    const store = new AssertionStore({ now: () => 0 })

    expect(() =>
      store.add({
        subject: 'user',
        attribute: '喜好',
        value: '咖啡',
        multiValued: true,
        evidence: '  ',
        confidence: 0.9
      })
    ).toThrow(/证据|evidence/)
  })
})

describe('断言层：用法与反馈', () => {
  it('默认只召回可以提的档位，伤痕类不主动出现', () => {
    const store = new AssertionStore({ now: () => 0 })
    store.ingest('我住在重庆')
    store.ingest('我讨厌被追问面试结果')

    const recalled = store.recall('重庆')
    expect(recalled.some((item) => item.assertion.value === '重庆')).toBe(true)
    expect(recalled.every((item) => item.assertion.mentionPolicy !== 'avoid_unless_asked')).toBe(true)
  })

  it('被用户纠正一次之后，这条不再主动召回', () => {
    const store = new AssertionStore({ now: () => 0 })
    const [created] = store.ingest('我住在重庆')
    expect(created).toBeDefined()

    const corrected = store.feedback(created?.id ?? '', 'corrected')
    expect(corrected.mentionPolicy).toBe('avoid_unless_asked')
    expect(corrected.corrections).toBe(1)

    const recalled = store.recall('重庆')
    expect(recalled.some((item) => item.assertion.id === created?.id)).toBe(false)
  })

  it('被接住会提高可提及性，但不会越过 1', () => {
    const store = new AssertionStore({ now: () => 0 })
    const [created] = store.ingest('我住在重庆')
    const id = created?.id ?? ''

    for (let i = 0; i < 20; i += 1) store.feedback(id, 'accepted')

    const item = store.all().find((entry) => entry.id === id)
    expect(item?.confidence).toBeLessThanOrEqual(1)
    expect(item?.importance).toBeLessThanOrEqual(1)
  })
})
