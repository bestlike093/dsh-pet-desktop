import { describe, expect, it } from 'vitest'
import type { DiagnosticsSnapshot } from '../diagnostics.js'
import { buildPanelView, panelRows } from '../panelView.js'

function snapshot(sections: DiagnosticsSnapshot['sections']): DiagnosticsSnapshot {
  return {
    version: '2.0.0',
    generatedAt: 1000,
    ok: false,
    bridge: 'connected',
    sections
  }
}

describe('诊断面板两级视图', () => {
  it('按 group → kind 两级组织，组内按 kind 稳定排序', () => {
    const view = buildPanelView(
      snapshot([
        { name: 'vault', ok: true, level: 'ok', data: { group: 'security', kind: 'credential' } },
        { name: 'host', ok: false, level: 'error', data: { group: 'security', kind: 'capability' } },
        { name: 'pipeline', ok: true, data: { group: 'media', kind: 'video' } }
      ])
    )

    expect(view.groups.map((group) => group.group)).toEqual(['security', 'media'])
    expect(view.groups[0]?.rows.map((row) => row.kind)).toEqual(['capability', 'credential'])
    expect(view.groups[1]?.rows.map((row) => row.kind)).toEqual(['video'])
  })

  it('fixHint 永远非空：数据源没给就按错误码补', () => {
    const view = buildPanelView(
      snapshot([
        { name: 'a', ok: false, level: 'error', code: 'PERMISSION_DENIED' },
        { name: 'b', ok: true, level: 'warn', data: { fixHint: '' } },
        { name: 'c', ok: true, data: { fixHint: '先看日志' } }
      ])
    )

    const rows = panelRows(view)
    for (const row of rows) {
      expect(row.fixHint.length).toBeGreaterThan(0)
    }
    expect(rows.find((row) => row.id === 'a')?.fixHint).toContain('权限')
    expect(rows.find((row) => row.id === 'c')?.fixHint).toBe('先看日志')
  })

  it('recoveredFrom 单独成字段，不混入 detail', () => {
    const view = buildPanelView(
      snapshot([
        {
          name: 'vault',
          ok: true,
          level: 'warn',
          data: {
            group: 'security',
            kind: 'credential',
            recoveredFrom: 'C:\\Users\\alice\\AppData\\key.corrupt-1'
          }
        }
      ])
    )

    const row = panelRows(view)[0]
    expect(row?.recoveredFrom).toContain('corrupt-1')
    expect(row?.detail).not.toContain('recoveredFrom')
    expect(row?.detail).not.toContain('corrupt-1')
  })
})
