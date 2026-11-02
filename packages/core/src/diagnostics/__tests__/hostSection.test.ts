import { describe, expect, it } from 'vitest'
import type { HostCapability } from '@pet/shared'
import { Diagnostics } from '../diagnostics.js'
import { toHostSection, registerHostDiagnostics } from '../hostSection.js'
import { resolveHostCapabilities } from '../../modules/hostCapability.js'

describe('S3 宿主能力诊断：来源必须写明', () => {
  it('声明值时标 warn，并明确写「自动探测不可用，使用声明值」', () => {
    const section = toHostSection({
      source: 'declared',
      snapshot: { version: '0.2.0', available: ['ask', 'approval'] as const satisfies readonly HostCapability[] }
    })

    expect(section.level).toBe('warn')
    expect(section.code).toBe('HOST_DECLARED')
    expect(section.message).toBe('自动探测不可用，使用声明值')
    expect(section.data).toMatchObject({ source: 'declared', available: 'ask,approval' })
  })

  it('探测可用时才是 ok', () => {
    const section = toHostSection({
      source: 'detected',
      snapshot: { version: '0.2.1', available: ['ask'] as const satisfies readonly HostCapability[] }
    })

    expect(section.ok).toBe(true)
    expect(section.level).toBe('ok')
    expect(section.code).toBe('HOST_DETECTED')
  })

  it('无声明可回落时标 error，不伪装成正常', () => {
    const section = toHostSection({
      source: 'fallback',
      snapshot: { version: '0.0.0-unknown', available: [] as const satisfies readonly HostCapability[] }
    })

    expect(section.ok).toBe(false)
    expect(section.level).toBe('error')
    expect(section.code).toBe('HOST_UNKNOWN')
    expect(section.message).toContain('已全部降级')
  })

  it('注册进聚合器后能出现在面板行里', async () => {
    const diagnostics = new Diagnostics({ version: '2.0.0', now: () => 1 })
    registerHostDiagnostics(diagnostics, {
      source: 'declared',
      snapshot: { version: '0.2.0', available: ['ask'] as const satisfies readonly HostCapability[] }
    })

    const snapshot = await diagnostics.collect()

    expect(snapshot.sections[0]?.name).toBe('host')
    expect(snapshot.sections[0]?.level).toBe('warn')
    expect(snapshot.sections[0]?.message).toContain('声明值')
  })
})

describe('声明值可被真机探测覆盖', () => {
  it('探测结果与声明冲突时，以探测为准', async () => {
    const result = await resolveHostCapabilities({
      detect: () => ({ version: '0.3.0', available: ['ask', 'approval', 'tray'] as const satisfies readonly HostCapability[] }),
      declaration: { version: '0.2.0', available: ['ask'] as const satisfies readonly HostCapability[] }
    })

    expect(result.source).toBe('detected')
    expect(result.snapshot.version).toBe('0.3.0')
    expect(result.snapshot.available).toEqual(['ask', 'approval', 'tray'])
  })
})
