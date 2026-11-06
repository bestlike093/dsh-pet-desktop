import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '../../types/settings.js'
import { migrateSettings } from '../migrate.js'

function words(raw: unknown) {
  const result = migrateSettings({ schemaVersion: 2, wakeWords: raw })
  expect(result.ok).toBe(true)
  if (!result.ok) return []
  return result.value.wakeWords
}

describe('唤醒词设置迁移', () => {
  it('缺省时留空，表示跟随内置默认', () => {
    const result = migrateSettings({ schemaVersion: 2 })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.wakeWords).toEqual([])
    expect(DEFAULT_SETTINGS.wakeWords).toEqual([])
  })

  it('保留填写的顺序', () => {
    expect(words(['小涟', '昔涟'])).toEqual(['小涟', '昔涟'])
  })

  it('去掉首尾空白与重复项', () => {
    expect(words([' 昔涟 ', '昔涟', '迷迷'])).toEqual(['昔涟', '迷迷'])
  })

  it('跳过非字符串与纯空白', () => {
    expect(words(['昔涟', 42, null, '   ', '迷迷'])).toEqual(['昔涟', '迷迷'])
  })

  it('最多保留 8 个', () => {
    const many = ['一', '二', '三', '四', '五', '六', '七', '八', '九']
    expect(words(many)).toHaveLength(8)
  })

  it('单个词截断到 16 字', () => {
    const long = '涟'.repeat(40)
    expect(words([long])[0]).toHaveLength(16)
  })

  it('不是数组时回到空值', () => {
    expect(words('昔涟')).toEqual([])
    expect(words(undefined)).toEqual([])
  })

  it('v1 配置里出现唤醒词也接管，不落进 legacy', () => {
    const result = migrateSettings({ schemaVersion: 1, wakeWords: ['小涟'] })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.wakeWords).toEqual(['小涟'])
    expect(result.legacy['wakeWords']).toBeUndefined()
  })
})
