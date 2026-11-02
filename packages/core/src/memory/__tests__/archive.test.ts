import { describe, expect, it } from 'vitest'
import { dayKey, groupByDay, parseArchive, renderArchive } from '../archive.js'
import type { MemoryEntry } from '../archive.js'

/** 用 UTC 拼分钟级时间戳，避免测试受宿主机时区影响。 */
function at(year: number, month: number, day: number, hour: number, minute: number): number {
  return Date.UTC(year, month - 1, day, hour, minute)
}

describe('dayKey', () => {
  it('按 UTC 偏移取日期', () => {
    expect(dayKey(at(2026, 10, 31, 23, 30), 0)).toBe('2026-10-31')
  })

  it('跨零点时归到正确的天', () => {
    // UTC 16:00 + 8h = 次日 00:00
    expect(dayKey(at(2026, 10, 31, 16, 0), 480)).toBe('2026-11-01')
  })
})

describe('groupByDay', () => {
  it('按天分组并保持升序', () => {
    const entries: MemoryEntry[] = [
      { at: at(2026, 11, 1, 9, 0), kind: 'note', text: '第二天' },
      { at: at(2026, 10, 31, 22, 0), kind: 'talk', text: '第一天的晚上' },
      { at: at(2026, 10, 31, 8, 0), kind: 'event', text: '第一天的早上' }
    ]

    const groups = groupByDay(entries, 0)
    expect([...groups.keys()]).toEqual(['2026-10-31', '2026-11-01'])
    expect(groups.get('2026-10-31')?.map((entry) => entry.text)).toEqual([
      '第一天的早上',
      '第一天的晚上'
    ])
  })
})

describe('renderArchive', () => {
  it('空列表渲染成空串', () => {
    expect(renderArchive([], 0)).toBe('')
  })

  it('按天分节，条目带时分与类型', () => {
    const markdown = renderArchive(
      [
        { at: at(2026, 10, 31, 22, 45), kind: 'talk', text: '她说晚安' },
        { at: at(2026, 10, 31, 23, 5), kind: 'note', text: '今天很安静' }
      ],
      0
    )

    expect(markdown).toContain('## 2026-10-31')
    expect(markdown).toContain('### 22:45 · talk')
    expect(markdown).toContain('她说晚安')
    expect(markdown).toContain('### 23:05 · note')
  })

  it('正文里的标题不会被误认成条目', () => {
    const text = '# 不是标题\n\n### 也不是条目\n\n- 不是列表\n\n```ts\nconst a = 1\n```'
    const markdown = renderArchive([{ at: at(2026, 10, 31, 10, 0), kind: 'note', text }], 0)

    expect(markdown).toContain('> # 不是标题')
    expect(markdown).toContain('> ### 也不是条目')

    const parsed = parseArchive(markdown, { offsetMinutes: 0 })
    expect(parsed).toHaveLength(1)
    expect(parsed[0]?.text).toBe(text)
  })
})

describe('parseArchive', () => {
  it('渲染后解析能还原条数与内容', () => {
    const entries: MemoryEntry[] = [
      { at: at(2026, 10, 31, 8, 0), kind: 'event', text: '起床' },
      { at: at(2026, 10, 31, 22, 45), kind: 'talk', text: '她说晚安' },
      { at: at(2026, 11, 1, 0, 30), kind: 'note', text: '跨天了' }
    ]

    const parsed = parseArchive(renderArchive(entries, 0), { offsetMinutes: 0 })

    expect(parsed.map((entry) => entry.text)).toEqual(['起床', '她说晚安', '跨天了'])
    expect(parsed.map((entry) => entry.kind)).toEqual(['event', 'talk', 'note'])
    expect(parsed.map((entry) => entry.at)).toEqual(entries.map((entry) => entry.at))
  })

  it('多行正文不丢行', () => {
    const text = '第一行\n\n第三行\n- 一个列表项'
    const parsed = parseArchive(
      renderArchive([{ at: at(2026, 10, 31, 12, 0), kind: 'note', text }], 0),
      { offsetMinutes: 0 }
    )

    expect(parsed).toHaveLength(1)
    expect(parsed[0]?.text).toBe(text)
  })

  it('认不出的行直接跳过，不污染其他条目', () => {
    const markdown = [
      '# 一些前言',
      '随手写的东西',
      '## 2026-10-31',
      '### 10:00 · talk',
      '正常条目',
      '### 乱码行',
      '应该被忽略',
      '### 11:00 · event',
      '另一个条目'
    ].join('\n')

    const parsed = parseArchive(markdown, { offsetMinutes: 0 })
    expect(parsed.map((entry) => entry.text)).toEqual(['正常条目', '另一个条目'])
  })

  it('空正文的条目被丢弃', () => {
    const markdown = ['## 2026-10-31', '### 10:00 · talk', '', '### 11:00 · note', '有内容'].join(
      '\n'
    )

    const parsed = parseArchive(markdown, { offsetMinutes: 0 })
    expect(parsed).toHaveLength(1)
    expect(parsed[0]?.text).toBe('有内容')
  })

  it('没有日期节时挂到给定日期', () => {
    const markdown = ['### 09:30 · note', '只有时间没有日期'].join('\n')

    const parsed = parseArchive(markdown, {
      offsetMinutes: 0,
      now: at(2026, 10, 31, 12, 0)
    })

    expect(parsed).toHaveLength(1)
    expect(parsed[0]?.at).toBe(at(2026, 10, 31, 9, 30))
  })

  it('空字符串解析成空数组', () => {
    expect(parseArchive('', { offsetMinutes: 0 })).toEqual([])
  })
})
