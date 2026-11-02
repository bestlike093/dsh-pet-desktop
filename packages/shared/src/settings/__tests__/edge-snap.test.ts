import { describe, expect, it } from 'vitest'
import { migrateSettingsOrThrow } from '../migrate.js'

const distanceOf = (edgeSnapDistance: unknown) =>
  migrateSettingsOrThrow({ schemaVersion: 2, window: { edgeSnapDistance } }).value.window
    .edgeSnapDistance

describe('边缘吸附距离', () => {
  it('缺省回落 12', () => {
    expect(distanceOf(undefined)).toBe(12)
  })

  it('低于 4 抬到 4，高于 64 压到 64', () => {
    expect(distanceOf(0)).toBe(4)
    expect(distanceOf(100)).toBe(64)
  })

  it('小数四舍五入', () => {
    expect(distanceOf(9.6)).toBe(10)
  })
})
