import { describe, expect, it } from 'vitest'
import type { ModuleHost, ModuleRuntime } from '../../modules/moduleHost.js'
import type { DiagnosticsSnapshot } from '../diagnostics.js'
import { bootDiagnosticsPanel } from '../panelBoot.js'
import { createFakeContainer, type FakeNode } from './fakeDom.js'

function snapshot(): DiagnosticsSnapshot {
  return {
    version: '2.0.0',
    generatedAt: 1000,
    ok: true,
    sections: [],
    bridge: 'connected'
  }
}

describe('诊断面板装配顺序（17.2.18）', () => {
  it('startAll 被调用时，容器里已经挂着 pending 面板', async () => {
    const container = createFakeContainer()
    let observed: { children: number; state: string | undefined } = { children: -1, state: undefined }

    const host = {
      startAll: async () => {
        observed = {
          children: container.children.length,
          state: container.children[0]?.dataset.state
        }
        return [] as readonly ModuleRuntime[]
      }
    } as unknown as ModuleHost

    await bootDiagnosticsPanel({
      container: container as unknown as Element,
      host,
      load: async () => snapshot()
    })

    expect(observed.children).toBe(1)
    expect(observed.state).toBe('pending')
  })

  it('refresh 在 startAll 之后执行，完成后转 ready', async () => {
    const events: string[] = []
    const container = createFakeContainer()

    const host = {
      startAll: async () => {
        events.push('startAll')
        return [] as readonly ModuleRuntime[]
      }
    } as unknown as ModuleHost

    const result = await bootDiagnosticsPanel({
      container: container as unknown as Element,
      host,
      load: async () => {
        events.push('refresh')
        return snapshot()
      }
    })

    expect(events).toEqual(['startAll', 'refresh'])
    expect((result.mount.element as unknown as FakeNode).dataset.state).toBe('ready')
  })

  it('面板不依赖模块：没有任何模块时也能挂载并完成一轮', async () => {
    const container = createFakeContainer()
    const host = {
      startAll: async () => [] as readonly ModuleRuntime[]
    } as unknown as ModuleHost

    const result = await bootDiagnosticsPanel({
      container: container as unknown as Element,
      host,
      load: async () => snapshot()
    })

    expect(result.statuses).toEqual([])
    expect((result.mount.element as unknown as FakeNode).dataset.state).toBe('ready')
  })
})
