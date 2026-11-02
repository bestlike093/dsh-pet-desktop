import { describe, expect, it } from 'vitest'
import type { DiagnosticsSnapshot } from '../diagnostics.js'
import { createPanelController, type PanelStatus } from '../panelState.js'

function snapshot(version: string): DiagnosticsSnapshot {
  return {
    version,
    generatedAt: 1,
    ok: true,
    sections: [],
    bridge: 'connected'
  }
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('诊断面板 epoch 守卫', () => {
  it('连发两次、第一次后到：最终显示第二次的结果', async () => {
    const first = deferred<DiagnosticsSnapshot>()
    const second = deferred<DiagnosticsSnapshot>()
    const queue = [first, second]
    const seen: PanelStatus[] = []

    const controller = createPanelController({
      load: () => {
        const next = queue.shift()
        if (next === undefined) throw new Error('没有更多请求')
        return next.promise
      },
      render: (status) => seen.push(status)
    })

    const firstRun = controller.refresh()
    const secondRun = controller.refresh()

    // 第二次先回来
    second.resolve(snapshot('second'))
    await secondRun

    // 第一次迟到
    first.resolve(snapshot('first'))
    await firstRun

    const last = controller.status()
    expect(last.kind).toBe('ready')
    if (last.kind === 'ready') {
      expect(last.snapshot.version).toBe('second')
    }
    expect(seen.filter((status) => status.kind === 'ready')).toHaveLength(1)
  })

  it('未返回时是 pending 分支，不与 ok 同源', async () => {
    const gate = deferred<DiagnosticsSnapshot>()
    const controller = createPanelController({
      load: () => gate.promise,
      render: () => {}
    })

    const run = controller.refresh()
    const pending = controller.status()

    expect(pending.kind).toBe('pending')
    expect('snapshot' in pending).toBe(false)
    expect(JSON.stringify(pending)).not.toContain('ok')

    gate.resolve(snapshot('v1'))
    await run
    expect(controller.status().kind).toBe('ready')
  })

  it('dispose 后在途结果不再写状态', async () => {
    const gate = deferred<DiagnosticsSnapshot>()
    const seen: PanelStatus[] = []
    const controller = createPanelController({
      load: () => gate.promise,
      render: (status) => seen.push(status)
    })

    const run = controller.refresh()
    controller.dispose()
    gate.resolve(snapshot('late'))
    await run

    expect(controller.status().kind).toBe('pending')
    expect(seen.some((status) => status.kind === 'ready')).toBe(false)
  })
})
