import { describe, expect, it } from 'vitest'
import type { HostCapability, IPetalModule } from '@pet/shared'
import { ModuleHost } from '../../modules/moduleHost.js'
import { PermissionBroker } from '../../modules/permissionBroker.js'
import { PetalRegistry } from '../../modules/petalRegistry.js'
import { Diagnostics } from '../diagnostics.js'
import { MODULES_SECTION, registerModuleDiagnostics, toModulesSection } from '../modulesSection.js'
import { buildPanelView, panelRows } from '../panelView.js'

const root = {} as ShadowRoot

const FULL_HOST = {
  version: '0.2.0',
  available: ['ask', 'approval', 'taskProgress', 'settings', 'tray', 'window'] as HostCapability[]
}

/** 模块生命周期状态只允许这几个词；ok / success 属于 severity 维度，不得混入。 */
const MODULE_STATUSES = new Set([
  'unloaded',
  'loading',
  'ready',
  'degraded',
  'stopping',
  'stopped',
  'failed',
  'disabled'
])

function moduleOf(id: string, bootstrap: () => Promise<void>): IPetalModule {
  return {
    meta: { id, name: id, version: '1.0.0', permissions: [], tier: 'general' },
    bootstrap,
    teardown: async () => {}
  }
}

interface Harness {
  host: ModuleHost
  failFlaky: () => void
}

async function buildHost(): Promise<Harness> {
  const registry = new PetalRegistry()
  let flakyFails = false

  registry.register(moduleOf('alpha', async () => {}))
  registry.register(
    moduleOf('flaky', async () => {
      if (flakyFails) throw new Error('第二次启动失败')
    })
  )

  const host = new ModuleHost(registry, new PermissionBroker(), { root, hostCapabilities: FULL_HOST })
  await host.startAll()

  return { host, failFlaky: () => (flakyFails = true) }
}

function statesOf(host: ModuleHost): string {
  return host.statuses().map((runtime) => `${runtime.id}=${runtime.status}`).join(', ')
}

function sectionOf(snapshot: Awaited<ReturnType<Diagnostics['collect']>>) {
  return snapshot.sections.find((item) => item.name === MODULES_SECTION)
}

describe('模块状态诊断（17.2.18 ③）', () => {
  it('注册后模块再失败，下一次 collect 必须显示 failed（不是注册时快照）', async () => {
    const { host, failFlaky } = await buildHost()
    const diagnostics = new Diagnostics({ version: '2.0.0' })
    registerModuleDiagnostics(diagnostics, host)

    // 启动完成这一刻，两个模块都是 ready。
    expect(sectionOf(await diagnostics.collect())?.data).toMatchObject({
      states: 'alpha=ready, flaky=ready'
    })

    // 让 flaky 真的失败一次，再收诊断。
    await host.stop('flaky')
    failFlaky()
    expect(await host.start('flaky')).toBe(false)

    const states = (sectionOf(await diagnostics.collect())?.data as { states: string }).states
    expect(states).toContain('flaky=failed')
    expect(states).toBe(statesOf(host))
  })

  it('诊断里的模块状态与 ModuleHost.statuses() 逐项一致', async () => {
    const { host } = await buildHost()
    const diagnostics = new Diagnostics({ version: '2.0.0' })
    registerModuleDiagnostics(diagnostics, host)

    const snapshot = await diagnostics.collect()
    const section = sectionOf(snapshot)

    expect(section?.level).toBe('ok')
    expect((section?.data as { states: string }).states).toBe(statesOf(host))
  })

  it('宿主状态变化后，下一次诊断跟着变（不缓存第二份状态）', async () => {
    const { host } = await buildHost()
    const diagnostics = new Diagnostics({ version: '2.0.0' })
    registerModuleDiagnostics(diagnostics, host)

    await host.stop('alpha')

    const states = (sectionOf(await diagnostics.collect())?.data as { states: string }).states
    expect(states).toContain('alpha=stopped')
    expect(states).toBe(statesOf(host))
  })

  it('模块状态词汇表单一：不出现 ok / success', async () => {
    const { host } = await buildHost()
    const diagnostics = new Diagnostics({ version: '2.0.0' })
    registerModuleDiagnostics(diagnostics, host)

    const states = (sectionOf(await diagnostics.collect())?.data as { states: string }).states

    for (const runtime of host.statuses()) {
      expect(MODULE_STATUSES.has(runtime.status)).toBe(true)
    }
    expect(states).not.toMatch(/=(ok|success)\b/)
  })

  it('面板视图能列出模块组与失败模块', async () => {
    const { host, failFlaky } = await buildHost()
    const diagnostics = new Diagnostics({ version: '2.0.0' })
    registerModuleDiagnostics(diagnostics, host)

    await host.stop('flaky')
    failFlaky()
    await host.start('flaky')

    const view = buildPanelView(await diagnostics.collect())
    const group = view.groups.find((item) => item.group === 'modules')

    expect(group).toBeDefined()
    expect(panelRows(view).some((row) => row.detail.includes('flaky=failed'))).toBe(true)
  })
})

describe('degraded 不得显示为错误（③-c 收口）', () => {
  const DEGRADED: IPetalModule = {
    meta: {
      id: 'tray-menu',
      name: 'tray-menu',
      version: '1.0.0',
      permissions: [],
      tier: 'general',
      hostCapabilities: ['tray'] as const satisfies readonly HostCapability[]
    },
    bootstrap: async () => {},
    teardown: async () => {}
  }

  const BROKEN: IPetalModule = {
    meta: { id: 'broken', name: 'broken', version: '1.0.0', permissions: [], tier: 'general' },
    bootstrap: async () => {
      throw new Error('boom')
    },
    teardown: async () => {}
  }

  function hostWith(modules: readonly IPetalModule[]): ModuleHost {
    const registry = new PetalRegistry()
    for (const module of modules) registry.register(module)
    return new ModuleHost(registry, new PermissionBroker(), {
      root,
      hostCapabilities: { version: '0.2.0', available: [] as const satisfies readonly HostCapability[] }
    })
  }

  it('只有 degraded 时记 warn，不记 error', async () => {
    const host = hostWith([DEGRADED])
    await host.startAll()

    const section = toModulesSection(host.statuses())

    expect(section.level).toBe('warn')
    expect(section.level).not.toBe('error')
    expect(section.ok).toBe(true)
    expect((section.data as { states: string }).states).toBe('tray-menu=degraded')
  })

  it('failed 仍然记 error，degraded 不会把它盖成 warn', async () => {
    const host = hostWith([DEGRADED, BROKEN])
    await host.startAll()

    const section = toModulesSection(host.statuses())

    expect(section.level).toBe('error')
    expect(section.ok).toBe(false)
  })
})
