import { describe, expect, it } from 'vitest'
import { buildMemoryDigest, type MemoryTurn } from '../memory.js'

const turns = (roles: Array<'user' | 'assistant'>, text: string): MemoryTurn[] =>
  roles.map((role) => ({ role, text: `${text}-${role}` }))

const base = {
  enabled: true,
  available: true,
  count: 4,
  items: turns(['user', 'assistant', 'user', 'assistant'], 'm'),
  historyLength: 0
}

describe('buildMemoryDigest', () => {
  it('未启用返回空串', () => {
    expect(buildMemoryDigest({ ...base, enabled: false })).toBe('')
  })

  it('存储不可用返回空串', () => {
    expect(buildMemoryDigest({ ...base, available: false })).toBe('')
  })

  it('条目为 0 返回空串', () => {
    expect(buildMemoryDigest({ ...base, count: 0 })).toBe('')
  })

  it('历史覆盖全部记忆时返回空串', () => {
    expect(buildMemoryDigest({ ...base, historyLength: 4 })).toBe('')
    expect(buildMemoryDigest({ ...base, historyLength: 10 })).toBe('')
  })

  it('只保留历史没覆盖的更早片段', () => {
    expect(buildMemoryDigest({ ...base, historyLength: 2 })).toBe(
      ['用户：m-user', '你：m-assistant'].join('\n')
    )
  })

  it('历史为 0 时按顺序输出全部', () => {
    expect(buildMemoryDigest(base)).toBe(
      ['用户：m-user', '你：m-assistant', '用户：m-user', '你：m-assistant'].join('\n')
    )
  })

  it('非 user 角色统一标成「你」', () => {
    expect(
      buildMemoryDigest({
        ...base,
        count: 1,
        items: [{ role: 'system', text: 'x' }]
      })
    ).toBe('你：x')
  })

  it('有时间的条目带上「前天」这种人话，没有时间的不加前缀', () => {
    expect(
      buildMemoryDigest({
        ...base,
        count: 2,
        items: [
          { role: 'user', text: '要交的东西做完了', when: '前天 21:40' },
          { role: 'assistant', text: '那就好' }
        ]
      })
    ).toBe(['前天 21:40 用户：要交的东西做完了', '你：那就好'].join('\n'))
  })

  it('空 items 不抛', () => {
    expect(buildMemoryDigest({ ...base, count: 0, items: [] })).toBe('')
  })

  it('给了当前这句时，优先挑词面相关的旧片段', () => {
    const items: MemoryTurn[] = [
      { role: 'user', text: '昨天在修一个 Electron 的白屏问题' },
      { role: 'user', text: '今天午饭吃了番茄炒蛋' },
      { role: 'assistant', text: '番茄炒蛋听起来不错' },
      { role: 'user', text: '白屏那个问题最后是打包路径错了' },
      { role: 'user', text: '周末想去看展' }
    ]
    const digest = buildMemoryDigest({
      ...base,
      count: 5,
      items,
      query: '白屏问题',
      limit: 2
    })
    expect(digest).toBe(
      ['用户：昨天在修一个 Electron 的白屏问题', '用户：白屏那个问题最后是打包路径错了'].join('\n')
    )
  })

  it('相关条目不够时用最近的补足，且不重复', () => {
    const items: MemoryTurn[] = [
      { role: 'user', text: '第一件旧事' },
      { role: 'user', text: '第二件旧事' },
      { role: 'user', text: '第三件旧事' },
      { role: 'user', text: '第四件旧事' }
    ]
    const digest = buildMemoryDigest({
      ...base,
      count: 4,
      items,
      query: '完全无关的词zzz',
      limit: 2
    })
    expect(digest).toBe(['用户：第三件旧事', '用户：第四件旧事'].join('\n'))
  })

  it('没有当前这句话时保持全量输出', () => {
    expect(buildMemoryDigest({ ...base, query: '' })).toBe(
      ['用户：m-user', '你：m-assistant', '用户：m-user', '你：m-assistant'].join('\n')
    )
  })

  it('只含常见口头语的条目不参与命中，不会压过主题条目', () => {
    const items: MemoryTurn[] = [
      { role: 'user', text: '今天，可以，我们，真的' },
      { role: 'user', text: '白屏' }
    ]
    const digest = buildMemoryDigest({
      ...base,
      count: 2,
      items,
      query: '今天，白屏',
      limit: 1
    })
    expect(digest).toBe('用户：白屏')
  })

  it('整句都是停用词时，按新近取，不拿常见词硬凑相关', () => {
    const items: MemoryTurn[] = [
      { role: 'user', text: '第一件旧事' },
      { role: 'user', text: '第二件旧事' },
      { role: 'user', text: '第三件旧事' }
    ]
    const digest = buildMemoryDigest({
      ...base,
      count: 3,
      items,
      query: '今天今天',
      limit: 2
    })
    expect(digest).toBe(['用户：第二件旧事', '用户：第三件旧事'].join('\n'))
  })

  it('IDF 压低高频词：只命中「项目」的条目排在命中「白屏」的条目后面', () => {
    const items: MemoryTurn[] = [
      { role: 'user', text: '项目进度' },
      { role: 'user', text: '项目进度' },
      { role: 'user', text: '项目进度' },
      { role: 'user', text: '项目进度' },
      { role: 'user', text: '项目进度' },
      { role: 'user', text: '白屏项目' }
    ]
    const digest = buildMemoryDigest({
      ...base,
      count: 6,
      items,
      query: '项目白屏',
      limit: 1
    })
    expect(digest).toBe('用户：白屏项目')
  })

  it('候选集扩到 200：超过 40 条的更早相关片段仍能被召回', () => {
    const items: MemoryTurn[] = [
      { role: 'user', text: '白屏问题' },
      ...Array.from({ length: 149 }, (_, index) => ({
        role: 'user' as const,
        text: `无关记录${index}`
      }))
    ]
    const digest = buildMemoryDigest({
      ...base,
      count: items.length,
      items,
      query: '白屏问题',
      limit: 1
    })
    expect(digest).toBe('用户：白屏问题')
  })
})
