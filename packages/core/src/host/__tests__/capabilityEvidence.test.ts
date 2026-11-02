import { describe, expect, it } from 'vitest'
import { HOST_CAPABILITIES } from '@pet/shared'
import {
  CAPABILITY_EVIDENCE,
  SERVICE_API_KEYS,
  resolveAvailableFromCatalog
} from '../capabilityEvidence.js'

describe('能力实据（③）：每项都必须可追溯', () => {
  it('12 项能力全覆盖，漏一项就失败', () => {
    expect(Object.keys(CAPABILITY_EVIDENCE).sort()).toEqual([...HOST_CAPABILITIES].sort())
  })

  it('api-catalog 项必须带 key，且 key 在 SERVICE_API 快照里', () => {
    const known = new Set<string>(SERVICE_API_KEYS)

    for (const [capability, evidence] of Object.entries(CAPABILITY_EVIDENCE)) {
      if (evidence.source !== 'api-catalog') continue

      expect(evidence.apiCatalogKey, `${capability} 缺少 apiCatalogKey`).toBeDefined()
      expect(
        known.has(evidence.apiCatalogKey as string),
        `${capability} 指向的 ${evidence.apiCatalogKey} 不在 SERVICE_API 里`
      ).toBe(true)
    }
  })

  it('assumed / observed 项必须给降级模式，否则不许进名单', () => {
    for (const [capability, evidence] of Object.entries(CAPABILITY_EVIDENCE)) {
      if (evidence.source !== 'assumed' && evidence.source !== 'observed') continue
      expect(
        evidence.degradeMode,
        `${capability} 是 ${evidence.source} 但没给降级模式`
      ).toBeDefined()
    }
  })

  it('assumed / observed 项不能带 apiCatalogKey，避免伪装成实据', () => {
    for (const [capability, evidence] of Object.entries(CAPABILITY_EVIDENCE)) {
      if (evidence.source !== 'assumed' && evidence.source !== 'observed') continue
      expect(evidence.apiCatalogKey, capability).toBeUndefined()
    }
  })

  it('tray 是人工实测（observed），不冒充 runtime', () => {
    expect(CAPABILITY_EVIDENCE.tray.source).toBe('observed')
    expect(CAPABILITY_EVIDENCE.tray.note).toContain('人工实测')
  })

  it('catalog 缺 key 时对应能力不点亮', () => {
    expect(resolveAvailableFromCatalog([])).toEqual([])
    expect(resolveAvailableFromCatalog(['llm'])).toEqual(['llmCall'])
  })

  it('完整 catalog 只点亮 api-catalog 项，assumed 项不参与', () => {
    const available = resolveAvailableFromCatalog(SERVICE_API_KEYS)

    expect(available).not.toContain('tray')
    expect(available).not.toContain('window')
    expect(available).toHaveLength(10)
  })
})
