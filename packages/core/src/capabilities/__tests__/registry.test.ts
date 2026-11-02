import { describe, expect, it } from 'vitest'
import {
  CAPABILITY_SPECS,
  capabilitiesByGroup,
  defaultCapabilities,
  describeResolution,
  getCapability,
  highRiskCapabilities,
  isCapabilityActive,
  resolveCapabilities,
  resolveFrom,
  type CapabilitySpec
} from '../registry'

/** 造一份可控清单，用来验证规则本身，不受真实注册表当前状态影响。 */
function spec(overrides: Partial<CapabilitySpec> & Pick<CapabilitySpec, 'id'>): CapabilitySpec {
  return {
    label: overrides.id,
    group: 'io',
    defaultState: 'off',
    risk: 'low',
    status: 'live',
    note: '测试用',
    ...overrides
  }
}

describe('能力注册表：结构自洽', () => {
  it('id 不重复', () => {
    const ids = CAPABILITY_SPECS.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('每个依赖都真实存在', () => {
    for (const s of CAPABILITY_SPECS) {
      for (const dep of s.dependsOn ?? []) {
        expect(getCapability(dep), `${s.id} 依赖 ${dep}`).toBeDefined()
      }
    }
  })

  it('依赖不成环', () => {
    const visit = (id: string, path: readonly string[]): void => {
      expect(path).not.toContain(id)
      const s = getCapability(id)
      for (const dep of s?.dependsOn ?? []) visit(dep, [...path, id])
    }
    for (const s of CAPABILITY_SPECS) visit(s.id, [])
  })

  it('每项都有标签和说明', () => {
    for (const s of CAPABILITY_SPECS) {
      expect(s.label.length).toBeGreaterThan(0)
      expect(s.note.length).toBeGreaterThan(0)
    }
  })

  it('六个分组都有内容', () => {
    for (const group of ['browse', 'media', 'social', 'io', 'agent', 'game'] as const) {
      expect(capabilitiesByGroup(group).length).toBeGreaterThan(0)
    }
  })

  it('status 只可能是 live 或省略（省略按 planned 算）', () => {
    for (const s of CAPABILITY_SPECS) {
      if (s.status !== undefined) expect(['live', 'planned']).toContain(s.status)
    }
  })

  it('标 live 的项必须默认能落地，不能是 manual 还标 live 却不给依赖', () => {
    // 这里只防一种错：标了 live 却 requireSetup 却没有 dependsOn 表达前置条件。
    for (const s of CAPABILITY_SPECS) {
      if (s.status === 'live') expect(s.defaultState).not.toBe('manual')
    }
  })
})

describe('注册表不说谎', () => {
  it('active 里只可能出现 live 项', () => {
    const liveIds = new Set(CAPABILITY_SPECS.filter((s) => s.status === 'live').map((s) => s.id))
    for (const id of resolveCapabilities().active) {
      expect(liveIds.has(id), `${id} 不是 live 却生效了`).toBe(true)
    }
  })

  it('每一项要么在 active，要么在 available / unavailable / blocked，不会凭空消失', () => {
    const resolution = resolveCapabilities()
    const covered = new Set([
      ...resolution.active,
      ...resolution.available,
      ...resolution.unavailable,
      ...resolution.blocked.map((b) => b.id)
    ])
    expect(covered.size).toBe(CAPABILITY_SPECS.length)
  })

  it('total 等于注册表长度', () => {
    expect(resolveCapabilities().total).toBe(CAPABILITY_SPECS.length)
  })

  it('已知还没接上的项落在 unavailable', () => {
    const unavailable = resolveCapabilities().unavailable
    for (const id of ['browse.browser', 'media.screenshot', 'media.music']) {
      expect(unavailable, id).toContain(id)
    }
  })

  it('已接上的项不在 unavailable 里', () => {
    const unavailable = new Set(resolveCapabilities().unavailable)
    for (const id of [
      'browse.read',
      'media.image',
      'media.live2d',
      'social.emoji',
      'io.file.read',
      'game.daily'
    ]) {
      expect(unavailable.has(id), id).toBe(false)
    }
  })
})

describe('默认值：按风险定，不按功能大小', () => {
  it('默认生效集合里没有任何高风险项', () => {
    const active = new Set(resolveCapabilities().active)
    for (const id of highRiskCapabilities()) {
      expect(active.has(id), id).toBe(false)
    }
  })

  it('真实注册表里默认生效的项', () => {
    expect([...resolveCapabilities().active].sort()).toEqual(
      [
        'agent.subagent',
        'browse.bilibili.read',
        'browse.read',
        'game.daily',
        'io.file.read',
        'media.image',
        'media.live2d',
        'social.emoji'
      ].sort()
    )
  })

  it('对外写操作默认关：内置浏览器、B 站五项、发动态、写文件、发邮件', () => {
    const active = resolveCapabilities().active
    for (const id of [
      'browse.browser',
      'browse.bilibili.comment',
      'browse.bilibili.like',
      'browse.bilibili.favorite',
      'browse.bilibili.coin',
      'browse.bilibili.share',
      'browse.post',
      'io.file.write',
      'io.mail.read',
      'io.mail.send'
    ]) {
      expect(active, id).not.toContain(id)
    }
  })

  it('defaultCapabilities 只列 live 且默认开的项', () => {
    const defaults = defaultCapabilities()
    for (const id of defaults) {
      const s = getCapability(id)
      expect(s?.defaultState).toBe('on')
      expect(s?.status).toBe('live')
    }
  })
})

describe('planned 项：点了也不生效', () => {
  it('点开一个 planned 项，仍不进 active', () => {
    const resolution = resolveCapabilities({ enabled: ['browse.browser'] })
    expect(resolution.active).not.toContain('browse.browser')
    expect(resolution.unavailable).toContain('browse.browser')
  })

  it('planned 项不混进 blocked，用户不会以为自己点错了', () => {
    const resolution = resolveCapabilities({ enabled: ['browse.browser'] })
    expect(resolution.blocked.map((b) => b.id)).not.toContain('browse.browser')
  })

  it('planned 的高风险项确认了也不生效', () => {
    const resolution = resolveCapabilities({
      enabled: ['game.clientControl'],
      acknowledged: ['game.clientControl']
    })
    expect(resolution.active).not.toContain('game.clientControl')
  })
})

describe('用户点开（用可控清单验证规则）', () => {
  const specs = [
    spec({ id: 'a', defaultState: 'off' }),
    spec({ id: 'b', defaultState: 'on' }),
    spec({ id: 'danger', defaultState: 'off', risk: 'high' })
  ]

  it('点开默认关的项才生效', () => {
    expect(resolveFrom(specs).active).toEqual(['b'])
    expect([...resolveFrom(specs, { enabled: ['a'] }).active].sort()).toEqual(['a', 'b'])
  })

  it('高风险项只点开不够，还要确认', () => {
    const resolution = resolveFrom(specs, { enabled: ['danger'] })
    expect(resolution.active).not.toContain('danger')
    expect(resolution.blocked.find((b) => b.id === 'danger')?.reason).toBe('not-acknowledged')
  })

  it('高风险项点开并确认后生效', () => {
    const resolution = resolveFrom(specs, {
      enabled: ['danger'],
      acknowledged: ['danger']
    })
    expect(resolution.active).toContain('danger')
  })

  it('关掉的优先级高于点开', () => {
    const resolution = resolveFrom(specs, { enabled: ['a'], disabled: ['a'] })
    expect(resolution.active).not.toContain('a')
    expect(resolution.blocked.find((b) => b.id === 'a')?.reason).toBe('turned-off')
  })

  it('默认开的项可以关掉', () => {
    const resolution = resolveFrom(specs, { disabled: ['b'] })
    expect(resolution.active).not.toContain('b')
  })
})

describe('依赖关系（用可控清单验证规则）', () => {
  const specs = [
    spec({ id: 'base', defaultState: 'on' }),
    spec({ id: 'mid', defaultState: 'off', dependsOn: ['base'] }),
    spec({ id: 'top', defaultState: 'off', dependsOn: ['mid'], risk: 'high' }),
    spec({ id: 'broken', defaultState: 'off', dependsOn: ['missing-parent'] })
  ]

  it('父项生效时子项才生效', () => {
    const resolution = resolveFrom(specs, { enabled: ['mid'] })
    expect(resolution.active).toContain('mid')
  })

  it('父项被关掉时，子项即使开了也不生效', () => {
    const resolution = resolveFrom(specs, { enabled: ['mid'], disabled: ['base'] })
    expect(resolution.active).not.toContain('mid')
    expect(resolution.blocked.find((b) => b.id === 'mid')?.reason).toBe('dependency-missing')
  })

  it('三层依赖按顺序生效', () => {
    const resolution = resolveFrom(specs, {
      enabled: ['mid', 'top'],
      acknowledged: ['top']
    })
    expect([...resolution.active].sort()).toEqual(['base', 'mid', 'top'])
  })

  it('中间一层断掉，末端也起不来', () => {
    const resolution = resolveFrom(specs, { enabled: ['mid', 'top'], disabled: ['mid'] })
    expect(resolution.active).not.toContain('top')
    expect(resolution.blocked.some((b) => b.id === 'top')).toBe(true)
  })

  it('依赖了不存在的父项时被拦，不会静默通过', () => {
    const resolution = resolveFrom(specs, { enabled: ['broken'] })
    expect(resolution.active).not.toContain('broken')
    expect(resolution.blocked.find((b) => b.id === 'broken')?.reason).toBe('dependency-missing')
  })
})

describe('设置卫生', () => {
  it('不认识的 id 被单独列出来，不影响其他项', () => {
    const resolution = resolveCapabilities({ enabled: ['not.a.real.capability'] })
    expect(resolution.unknown).toEqual(['not.a.real.capability'])
    expect(resolution.active.length).toBeGreaterThan(0)
  })

  it('空设置等同于全默认', () => {
    expect(resolveCapabilities({}).active).toEqual(resolveCapabilities().active)
  })

  it('概览文案能压成一行，并说出未接上的数量', () => {
    const text = describeResolution(resolveCapabilities())
    expect(text).toContain('项可用')
    expect(text).toContain('还没接上')
  })

  it('全部接上时概览不出现「还没接上」', () => {
    const allLive = [spec({ id: 'x', defaultState: 'on' })]
    const text = describeResolution(resolveFrom(allLive))
    expect(text).toBe('1 / 1 项可用')
  })
})

describe('isCapabilityActive', () => {
  it('只对 active 里的 id 返回 true', () => {
    const resolution = resolveCapabilities()
    expect(isCapabilityActive('media.image', resolution)).toBe(true)
    expect(isCapabilityActive('browse.browser', resolution)).toBe(false)
  })
})
