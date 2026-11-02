import { describe, expect, it } from 'vitest'
import { checkWatchdog, shouldClose, buildTimeoutReport, WATCHDOG_LEAD_MS } from '../watchdog'

const T = 1_700_000_000_000
const MIN = 60_000
const TIMEOUT = 150 * MIN

function base(overrides: Partial<Parameters<typeof checkWatchdog>[0]> = {}) {
  return {
    runId: 'run-1',
    game: 'genshin' as const,
    mode: 'real' as const,
    startedAt: T,
    timeoutMs: TIMEOUT,
    now: T,
    ...overrides
  }
}

describe('看门狗：什么时候该收尾', () => {
  it('刚开始跑的时候处于 running', () => {
    const verdict = checkWatchdog(base({ now: T + 10 * MIN }))
    expect(verdict.kind).toBe('running')
  })

  it('还剩超过 5 分钟时仍然 running', () => {
    const verdict = checkWatchdog(base({ now: T + TIMEOUT - WATCHDOG_LEAD_MS - 1 }))
    expect(verdict.kind).toBe('running')
  })

  it('正好进入最后 5 分钟就开始收尾', () => {
    const verdict = checkWatchdog(base({ now: T + TIMEOUT - WATCHDOG_LEAD_MS }))
    expect(verdict.kind).toBe('closing')
  })

  it('已经超过上限也收尾，不会一直开着', () => {
    const verdict = checkWatchdog(base({ now: T + TIMEOUT + 30 * MIN }))
    expect(verdict.kind).toBe('closing')
  })

  it('running 时能报出距离结束还剩多久', () => {
    const verdict = checkWatchdog(base({ now: T + 100 * MIN }))
    expect(verdict.kind).toBe('running')
    if (verdict.kind !== 'running') return
    expect(verdict.remainingMs).toBe(50 * MIN)
  })

  it('shouldClose 与 checkWatchdog 结论一致', () => {
    expect(shouldClose(base({ now: T + 10 * MIN }))).toBe(false)
    expect(shouldClose(base({ now: T + TIMEOUT - MIN }))).toBe(true)
  })
})

describe('看门狗：收尾报告', () => {
  it('状态写成 timeout，不写成 failed', () => {
    const verdict = checkWatchdog(base({ now: T + TIMEOUT - MIN }))
    expect(verdict.kind).toBe('closing')
    if (verdict.kind !== 'closing') return
    expect(verdict.report.status).toBe('timeout')
  })

  it('报告带着 runId、游戏与起止时间', () => {
    const verdict = checkWatchdog(base({ now: T + TIMEOUT - MIN }))
    if (verdict.kind !== 'closing') throw new Error('应当收尾')
    expect(verdict.report.runId).toBe('run-1')
    expect(verdict.report.game).toBe('genshin')
    expect(verdict.report.startedAt).toBe(T)
    expect(verdict.report.endedAt).toBe(T + TIMEOUT - MIN)
  })

  it('已经做过的步骤会被带进报告，不会丢', () => {
    const steps = [
      { name: '登录', ok: true },
      { name: '领每日', ok: true }
    ]
    const report = buildTimeoutReport(base({ now: T + TIMEOUT - MIN, steps }), T + TIMEOUT)
    expect(report.steps.map((step) => step.name)).toEqual(['登录', '领每日', '看门狗收尾'])
  })

  it('收尾这一步标成未完成，并写清跑了多久', () => {
    const report = buildTimeoutReport(base({ now: T + 149 * MIN }), T + TIMEOUT)
    const last = report.steps[report.steps.length - 1]
    expect(last?.ok).toBe(false)
    expect(last?.detail).toContain('149')
  })

  it('结论里写清上限和剩余缓冲', () => {
    const report = buildTimeoutReport(base({ now: T + TIMEOUT - MIN }), T + TIMEOUT)
    expect(report.conclusion).toContain('150')
    expect(report.conclusion).toContain('1')
  })

  it('沙盒里生成的报告不携带证据，避免伪造', () => {
    const report = buildTimeoutReport(base({ now: T + TIMEOUT - MIN }), T + TIMEOUT)
    expect(report.evidence).toEqual([])
  })
})
