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

  it('空 items 不抛', () => {
    expect(buildMemoryDigest({ ...base, count: 0, items: [] })).toBe('')
  })
})
