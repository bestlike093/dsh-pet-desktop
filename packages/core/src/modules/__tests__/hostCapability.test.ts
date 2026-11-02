import { describe, expect, it } from 'vitest'
import type { HostCapability } from '@pet/shared'
import {
  compareSemver,
  describeDegradation,
  evaluateModuleHost,
  parseHostCapabilityDeclaration,
  resolveHostCapabilities
} from '../hostCapability.js'

describe('宿主能力解析：探测 → 声明 → 降级', () => {
  it('探测可用时优先采用探测结果', async () => {
    const result = await resolveHostCapabilities({
      detect: async () => ({ version: '0.2.1', available: ['ask', 'approval'] as const satisfies readonly HostCapability[] }),
      declaration: { version: '0.1.0', available: ['tray'] as const satisfies readonly HostCapability[] }
    })

    expect(result.source).toBe('detected')
    expect(result.snapshot.version).toBe('0.2.1')
    expect(result.snapshot.available).toEqual(['ask', 'approval'])
  })

  it('探测抛错时回落到声明文件', async () => {
    const result = await resolveHostCapabilities({
      detect: async () => {
        throw new Error('dsh 接口不可达')
      },
      declaration: { version: '0.2.0', available: ['ask', 'approval', 'taskProgress'] as const satisfies readonly HostCapability[] }
    })

    expect(result.source).toBe('declared')
    expect(result.snapshot.available).toEqual(['ask', 'approval', 'taskProgress'])
  })

  it('探测返回空也视为拿不到，继续回落', async () => {
    const result = await resolveHostCapabilities({
      detect: () => ({ version: '0.2.0', available: [] as const satisfies readonly HostCapability[] }),
      declaration: { version: '0.2.0', available: ['tray'] as const satisfies readonly HostCapability[] }
    })

    expect(result.source).toBe('declared')
    expect(result.snapshot.available).toEqual(['tray'])
  })

  it('探测与声明都不可用 → 全部降级，不乐观放行', async () => {
    const result = await resolveHostCapabilities({})

    expect(result.source).toBe('fallback')
    expect(result.snapshot.available).toEqual([])
    expect(result.snapshot.version).toBe('0.0.0-unknown')
  })
})

describe('能力声明文件解析', () => {
  it('未知能力键忽略，保留白名单内的项', () => {
    const snapshot = parseHostCapabilityDeclaration({
      version: '0.2.0',
      // 故意含未知键 teleport：验证未知能力被忽略，不能收窄成 HostCapability。
      // parseHostCapabilityDeclaration 的参数签名是 unknown，本用例不绕过任何类型检查，也不是可照抄的示例。
      available: ['ask', 'teleport', 'approval', 'ask'] as const
    })

    expect(snapshot?.available).toEqual(['ask', 'approval'])
  })

  it('缺 version 时用 unknown 占位', () => {
    expect(parseHostCapabilityDeclaration({ available: [] as const satisfies readonly HostCapability[] })?.version).toBe('0.0.0-unknown')
  })

  it('非法输入返回 undefined', () => {
    expect(parseHostCapabilityDeclaration(null)).toBeUndefined()
    expect(parseHostCapabilityDeclaration('not-an-object')).toBeUndefined()
    expect(parseHostCapabilityDeclaration([])).toBeUndefined()
  })
})

describe('模块兼容性判定', () => {
  it('版本按三段数字比较，不看预发布标签', () => {
    expect(compareSemver('0.2.0', '0.2.1')).toBeLessThan(0)
    expect(compareSemver('1.0.0-beta', '1.0.0')).toBe(0)
    expect(compareSemver('2.0.0', '1.9.9')).toBeGreaterThan(0)
  })

  it('能力齐全且版本达标 → ok', () => {
    const result = evaluateModuleHost(
      {
        id: 'bubble',
        name: 'Bubble',
        version: '1.0.0',
        permissions: [],
        tier: 'general',
        hostCapabilities: ['ask'] as const satisfies readonly HostCapability[],
        minHostVersion: '0.2.0'
      },
      { version: '0.2.0', available: ['ask'] as const satisfies readonly HostCapability[] }
    )

    expect(result.ok).toBe(true)
    expect(result.missing).toEqual([])
  })

  it('缺能力时列出缺失项并给出降级说明', () => {
    const result = evaluateModuleHost(
      {
        id: 'approval',
        name: 'Approval',
        version: '1.0.0',
        permissions: [],
        tier: 'general',
        hostCapabilities: ['approval', 'tray'] as const satisfies readonly HostCapability[]
      },
      { version: '0.2.0', available: ['approval'] as const satisfies readonly HostCapability[] }
    )

    expect(result.ok).toBe(false)
    expect(result.reason).toBe('capability')
    expect(result.missing).toEqual(['tray'])
    expect(result.message).toContain('tray')
  })

  it('降级说明顺序固定，便于快照比对', () => {
    expect(describeDegradation(['window', 'ask'])).toEqual([
      'ask: 提问接管不可用：改成只读提示，不阻塞其他模块',
      'window: 窗口控制不可用：按固定画布尺寸渲染，不请求宿主改窗口'
    ])
  })

  it('纯插件形态：tray/window 报「不适用」而非「缺失」', () => {
    const result = evaluateModuleHost(
      {
        id: 'tray-menu',
        name: 'Tray Menu',
        version: '1.0.0',
        permissions: [],
        tier: 'general',
        hostCapabilities: ['tray', 'window'] as const satisfies readonly HostCapability[]
      },
      { version: '0.2.1', available: [] as const satisfies readonly HostCapability[], notApplicable: ['tray', 'window'] }
    )

    expect(result.ok).toBe(false)
    expect(result.reason).toBe('not-applicable')
    expect(result.missing).toEqual([])
    expect(result.notApplicable).toEqual(['tray', 'window'])
    expect(result.message).toContain('当前宿主形态不适用')
  })

  it('真缺失优先于不适用：同一模块混合两种情况时按 capability 报', () => {
    const result = evaluateModuleHost(
      {
        id: 'mixed',
        name: 'Mixed',
        version: '1.0.0',
        permissions: [],
        tier: 'general',
        hostCapabilities: ['tray', 'llmCall'] as const satisfies readonly HostCapability[]
      },
      { version: '0.2.1', available: [] as const satisfies readonly HostCapability[], notApplicable: ['tray'] }
    )

    expect(result.reason).toBe('capability')
    expect(result.missing).toEqual(['llmCall'])
    expect(result.notApplicable).toEqual(['tray'])
  })
})
