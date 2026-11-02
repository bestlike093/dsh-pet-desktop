/**
 * 分组排序：无 tier 的应用设置在前，模块分组按 MODULE_TIERS 顺序在后。
 *
 * 这条规则容易被写成「按 order 排」——那样 core 级模块可以被一个 order 数字
 * 挤到危险模块后面，等级就只剩标签作用了。所以单独测。
 */

import { describe, expect, it } from 'vitest'
import { SettingsRegistryV1 } from '../registry.js'
import type { SettingsGroupV1 } from '../types.js'

function group(id: string, extra: Partial<SettingsGroupV1> = {}): SettingsGroupV1 {
  return { id, label: id, ...extra }
}

function ids(registry: SettingsRegistryV1): readonly string[] {
  return registry.listGroups().map((item) => item.id)
}

describe('设置分组排序', () => {
  it('无 tier 的分组排在所有模块分组之前', () => {
    const r = new SettingsRegistryV1()
    r.registerGroup(group('modules.general', { tier: 'general' }))
    r.registerGroup(group('appearance', { order: 10 }))

    expect(ids(r)).toEqual(['appearance', 'modules.general'])
  })

  it('模块分组按 MODULE_TIERS 顺序，与声明顺序无关', () => {
    const r = new SettingsRegistryV1()
    // 故意倒着注册
    r.registerGroup(group('modules.critical', { tier: 'critical' }))
    r.registerGroup(group('modules.dangerous', { tier: 'dangerous' }))
    r.registerGroup(group('modules.core', { tier: 'core' }))
    r.registerGroup(group('modules.general', { tier: 'general' }))
    r.registerGroup(group('modules.essential', { tier: 'essential' }))

    expect(ids(r)).toEqual([
      'modules.core',
      'modules.essential',
      'modules.general',
      'modules.dangerous',
      'modules.critical'
    ])
  })

  it('同级分组内仍按 order、再按 id', () => {
    const r = new SettingsRegistryV1()
    r.registerGroup(group('modules.general.b', { tier: 'general', order: 20 }))
    r.registerGroup(group('modules.general.a', { tier: 'general', order: 10 }))
    r.registerGroup(group('modules.general.c', { tier: 'general', order: 20 }))

    expect(ids(r)).toEqual(['modules.general.a', 'modules.general.b', 'modules.general.c'])
  })
})
