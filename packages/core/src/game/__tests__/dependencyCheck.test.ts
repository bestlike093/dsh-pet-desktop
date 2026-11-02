import { describe, expect, it } from 'vitest'
import {
  KNOWN_DEPENDENCIES,
  describeDependencies,
  summarizeDependencies
} from '../dependencyCheck.js'
import type { DependencyItem } from '../dependencyCheck.js'

function item(overrides: Partial<DependencyItem> = {}): DependencyItem {
  return {
    id: 'x',
    label: '某项',
    required: true,
    status: 'ok',
    ...overrides
  }
}

describe('summarizeDependencies', () => {
  it('全齐时可以跑', () => {
    const report = summarizeDependencies([item(), item({ id: 'y' })])
    expect(report.canRun).toBe(true)
    expect(report.blocking).toEqual([])
  })

  it('必需项缺失会阻塞', () => {
    const report = summarizeDependencies([item({ status: 'missing' })])
    expect(report.canRun).toBe(false)
    expect(report.blocking).toHaveLength(1)
  })

  it('必需项未知也算阻塞，不假装通过', () => {
    const report = summarizeDependencies([item({ status: 'unknown' })])
    expect(report.canRun).toBe(false)
    expect(report.blocking[0]?.status).toBe('unknown')
  })

  it('非必需项缺失只算提醒，不阻塞', () => {
    const report = summarizeDependencies([item({ required: false, status: 'missing' })])
    expect(report.canRun).toBe(true)
    expect(report.warnings).toHaveLength(1)
  })

  it('warn 只进提醒', () => {
    const report = summarizeDependencies([item({ status: 'warn' })])
    expect(report.canRun).toBe(true)
    expect(report.warnings[0]?.status).toBe('warn')
  })

  it('空清单视为可以跑', () => {
    expect(summarizeDependencies([]).canRun).toBe(true)
  })
})

describe('describeDependencies', () => {
  it('全齐时说可以开始', () => {
    expect(describeDependencies(summarizeDependencies([item()]))).toBe('环境齐了，可以开始')
  })

  it('缺项时点名', () => {
    const report = summarizeDependencies([
      item({ id: 'a', label: 'BetterGI', status: 'missing' }),
      item({ id: 'b', label: '游戏路径', status: 'missing' })
    ])
    expect(describeDependencies(report)).toBe('还差 2 项：BetterGI、游戏路径')
  })

  it('能跑但有提醒时分开说', () => {
    const report = summarizeDependencies([item({ required: false, label: '计划任务权限', status: 'missing' })])
    expect(describeDependencies(report)).toContain('能跑')
    expect(describeDependencies(report)).toContain('计划任务权限')
  })
})

describe('KNOWN_DEPENDENCIES', () => {
  it('每项都有 id、label、fix', () => {
    for (const dep of Object.values(KNOWN_DEPENDENCIES)) {
      expect(dep.id.length).toBeGreaterThan(0)
      expect(dep.label.length).toBeGreaterThan(0)
      expect(dep.fix.length).toBeGreaterThan(0)
    }
  })

  it('BetterGI 与游戏路径都是必需项', () => {
    expect(KNOWN_DEPENDENCIES.bettergi.required).toBe(true)
    expect(KNOWN_DEPENDENCIES.gamePath.required).toBe(true)
  })
})
