import { describe, expect, it } from 'vitest'
import {
  DEFAULT_RECONCILE_GRACE_MS,
  firstFailure,
  isCompleted,
  parseReport,
  reconcileRun
} from '../dailyReport.js'
import type { DailyReport } from '../dailyReport.js'

const MINUTE = 60_000

function raw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    runId: 'run-1',
    game: 'genshin',
    mode: 'real',
    status: 'success',
    startedAt: 1000,
    endedAt: 2000,
    steps: [
      { name: '启动 BetterGI', ok: true, detail: 'pid 4242' },
      { name: '领取每日委托', ok: false, detail: '未找到 NPC' }
    ],
    evidence: ['screens/1.png'],
    conclusion: '大部分完成',
    ...overrides
  }
}

describe('parseReport', () => {
  it('解析完整报告', () => {
    const report = parseReport(raw())
    expect(report.runId).toBe('run-1')
    expect(report.steps).toHaveLength(2)
    expect(report.evidence).toEqual(['screens/1.png'])
  })

  it('缺 runId 直接抛错', () => {
    expect(() => parseReport(raw({ runId: undefined }))).toThrow()
  })

  it('缺 startedAt 直接抛错', () => {
    expect(() => parseReport(raw({ startedAt: undefined }))).toThrow()
  })

  it('mode 不合法直接抛错', () => {
    expect(() => parseReport(raw({ mode: 'fake' }))).toThrow()
  })

  it('未知 status 降级为 failed，不冒充成功', () => {
    expect(parseReport(raw({ status: 'done' })).status).toBe('failed')
  })

  it('缺 steps 与 evidence 时补空数组', () => {
    const report = parseReport(raw({ steps: undefined, evidence: undefined }))
    expect(report.steps).toEqual([])
    expect(report.evidence).toEqual([])
  })

  it('跳过结构不对的步骤', () => {
    const report = parseReport(raw({ steps: [{ ok: true }, { name: '有效', ok: true }] }))
    expect(report.steps).toEqual([{ name: '有效', ok: true }])
  })

  it('非对象输入直接抛错', () => {
    expect(() => parseReport('nope')).toThrow()
    expect(() => parseReport(null)).toThrow()
  })
})

describe('isCompleted', () => {
  it('只有 success 算完成', () => {
    const base = parseReport(raw())
    expect(isCompleted(base)).toBe(true)
    expect(isCompleted({ ...base, status: 'partial' })).toBe(false)
    expect(isCompleted({ ...base, status: 'timeout' })).toBe(false)
  })
})

describe('firstFailure', () => {
  it('挑出第一个失败步骤', () => {
    const report = parseReport(raw())
    expect(firstFailure(report)?.name).toBe('领取每日委托')
  })

  it('全都成功时返回 null', () => {
    const report = parseReport(raw({ steps: [{ name: 'a', ok: true }] }))
    expect(firstFailure(report)).toBeNull()
  })
})

describe('reconcileRun', () => {
  const expected = { runId: 'run-1', game: 'genshin' as const, mode: 'real' as const, startedAt: 1000 }

  it('有报告就直接采用', () => {
    const report: DailyReport = parseReport(raw())
    expect(reconcileRun({ expected, report, processAlive: true, now: 5000 })).toEqual({
      kind: 'ok',
      report
    })
  })

  it('进程还活着时先等着', () => {
    expect(reconcileRun({ expected, report: null, processAlive: true, now: 9_999_999 })).toEqual({
      kind: 'still-running'
    })
  })

  it('进程已退出但还在宽限期内，仍算运行中', () => {
    const now = expected.startedAt + DEFAULT_RECONCILE_GRACE_MS - 1
    expect(reconcileRun({ expected, report: null, processAlive: false, now })).toEqual({
      kind: 'still-running'
    })
  })

  it('进程已退出且过了宽限期，补一条 failed', () => {
    const now = expected.startedAt + DEFAULT_RECONCILE_GRACE_MS + 1
    const result = reconcileRun({ expected, report: null, processAlive: false, now })

    expect(result.kind).toBe('missing')
    if (result.kind !== 'missing') return

    expect(result.synthetic.status).toBe('failed')
    expect(result.synthetic.runId).toBe('run-1')
    expect(result.synthetic.steps[0]?.ok).toBe(false)
    expect(result.synthetic.endedAt).toBe(now)
  })

  it('可以自定义宽限期', () => {
    const result = reconcileRun({
      expected,
      report: null,
      processAlive: false,
      now: expected.startedAt + MINUTE,
      graceMs: 30_000
    })
    expect(result.kind).toBe('missing')
  })
})
