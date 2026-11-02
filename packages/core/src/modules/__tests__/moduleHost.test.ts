import { describe, expect, it } from 'vitest'
import { ErrorCode } from '@pet/shared'
import type { HostCapability, IPetalModule, ModuleConfig, ModuleContext, ModuleMeta } from '@pet/shared'
import { evaluateModuleHost } from '../hostCapability.js'
import { ModuleHost } from '../moduleHost.js'
import type { ModuleHostOptions } from '../moduleHost.js'
import { createRegistryModuleLoader } from '../moduleLoader.js'
import type { PlaceholderInfo, ServiceStopReason } from '../moduleHost.js'
import { PermissionBroker } from '../permissionBroker.js'
import { PetalRegistry } from '../petalRegistry.js'

const root = {} as ShadowRoot

const FULL_HOST = {
  version: '0.2.0',
  available: ['ask', 'approval', 'taskProgress', 'settings', 'tray', 'window'] as const
}

function moduleOf(
  id: string,
  meta: Partial<ModuleMeta> = {},
  bootstrap: (ctx: ModuleContext) => Promise<void> = async () => {}
): IPetalModule {
  return {
    meta: { id, name: id, version: '1.0.0', permissions: [], tier: 'general', ...meta },
    bootstrap,
    teardown: async () => {}
  }
}

interface HostSnapshot {
  readonly version: string
  readonly available: readonly HostCapability[]
  readonly notApplicable?: readonly HostCapability[]
}

function build(
  entries: readonly { module: IPetalModule; config?: Partial<ModuleConfig> }[],
  hostCapabilities?: HostSnapshot,
  placeholder?: (info: PlaceholderInfo) => { teardown(): void } | (() => void) | void,
  extra?: Partial<ModuleHostOptions>
): {
  host: ModuleHost
  placed: PlaceholderInfo[]
  removed: string[]
  permissions: PermissionBroker
} {
  const registry = new PetalRegistry()
  for (const entry of entries) registry.register(entry.module, entry.config)

  const placed: PlaceholderInfo[] = []
  const removed: string[] = []
  const permissions = new PermissionBroker()
  const host = new ModuleHost(registry, permissions, {
    root,
    ...(hostCapabilities === undefined ? {} : { hostCapabilities }),
    ...extra,
    placeholder: (info) => {
      placed.push(info)
      if (placeholder !== undefined) return placeholder(info)
      return () => {
        removed.push(info.id)
      }
    }
  })
  return { host, placed, removed, permissions }
}

function statusOf(host: ModuleHost, id: string): string | undefined {
  return host.statuses().find((runtime) => runtime.id === id)?.status
}

describe('S3 DoD ①：改坏一个模块，其余功能照常', () => {
  it('approval 抛错 → 该模块 failed + 占位，bubble 仍 running', async () => {
    const approval = moduleOf('approval', {}, async () => {
      throw new Error('approval 模块坏了')
    })
    const bubble = moduleOf('bubble')

    const { host, placed } = build([
      { module: approval },
      { module: bubble }
    ], FULL_HOST)

    const statuses = await host.startAll()

    expect(statuses).toHaveLength(2)
    expect(statusOf(host, 'approval')).toBe('failed')
    expect(statusOf(host, 'bubble')).toBe('ready')
    expect(placed).toHaveLength(1)
    expect(placed[0]?.id).toBe('approval')
    expect(placed[0]?.code).toBe(ErrorCode.LOAD_FAILED)
    expect(host.placeholderIds()).toEqual(['approval'])
  })

  it('占位在 stop 后清掉', async () => {
    const broken = moduleOf('broken', {}, async () => {
      throw new Error('boom')
    })
    const { host, removed } = build([{ module: broken }], FULL_HOST)

    await host.startAll()
    expect(host.placeholderIds()).toEqual(['broken'])

    await host.stop('broken')
    expect(host.placeholderIds()).toEqual([])
    expect(removed).toEqual(['broken'])
  })

  it('权限不足同样只影响自己', async () => {
    const needsNet = moduleOf('needs-net', { permissions: ['net.egress'] })
    const plain = moduleOf('plain')
    const { host, placed } = build([{ module: needsNet }, { module: plain }], FULL_HOST)

    await host.startAll()

    expect(statusOf(host, 'needs-net')).toBe('failed')
    expect(statusOf(host, 'plain')).toBe('ready')
    expect(placed[0]?.code).toBe(ErrorCode.PERMISSION_DENIED)
  })
})

describe('S3 能力声明：缺失即降级，不抛错', () => {
  it('声明 approval 但宿主没探测到 → NOT_SUPPORTED + 占位', async () => {
    const needsApproval = moduleOf('needs-approval', { hostCapabilities: ['approval'] as const satisfies readonly HostCapability[] })
    const { host, placed } = build([{ module: needsApproval }], {
      version: '0.2.0',
      available: ['ask'] as const satisfies readonly HostCapability[]
    })

    const ok = await host.start('needs-approval')

    expect(ok).toBe(false)
    expect(statusOf(host, 'needs-approval')).toBe('failed')
    expect(placed[0]?.code).toBe(ErrorCode.NOT_SUPPORTED)
    expect(placed[0]?.message).toContain('approval')
  })

  it('宿主版本低于 minHostVersion → 降级', async () => {
    const future = moduleOf('future', { minHostVersion: '0.5.0' })
    const { host, placed } = build([{ module: future }], FULL_HOST)

    await host.start('future')

    expect(statusOf(host, 'future')).toBe('failed')
    expect(placed[0]?.message).toContain('0.5.0')
  })

  it('未传能力快照时按「未探测」处理，不乐观放行', async () => {
    const needsTray = moduleOf('needs-tray', { hostCapabilities: ['tray'] as const satisfies readonly HostCapability[] })
    const { host, placed } = build([{ module: needsTray }])

    await host.start('needs-tray')

    expect(statusOf(host, 'needs-tray')).toBe('failed')
    expect(placed).toHaveLength(1)
  })
})

describe('S3 权限校验：白名单真的 reject，并记审计', () => {
  it('未授权启动不执行 bootstrap，audit 记 deny', async () => {
    let booted = false
    const needsNet = moduleOf('needs-net', { permissions: ['net.egress'] }, async () => {
      booted = true
    })
    const { host, permissions } = build([{ module: needsNet }], FULL_HOST)

    await host.start('needs-net')

    expect(booted).toBe(false)
    expect(statusOf(host, 'needs-net')).toBe('failed')
    expect(permissions.audit()).toEqual([
      { permission: 'net.egress', action: 'deny', at: expect.any(Number) }
    ])
  })

  it('授权后 bootstrap 能拿到对应沙箱接口', async () => {
    let hasNet = false
    const needsNet = moduleOf('needs-net', { permissions: ['net.egress'] }, async (ctx) => {
      hasNet = (ctx as { api?: { net?: unknown } }).api?.net !== undefined
    })
    const registry = new PetalRegistry()
    registry.register(needsNet)
    const permissions = new PermissionBroker(['net.egress'])
    const host = new ModuleHost(registry, permissions, { root, hostCapabilities: FULL_HOST })

    await host.start('needs-net')

    expect(hasNet).toBe(true)
    expect(statusOf(host, 'needs-net')).toBe('ready')
    expect(permissions.audit()).toEqual([])
  })

  it('模块未声明的权限不会因宿主有授予而出现在沙箱里', async () => {
    let memoryApi: unknown = 'unset'
    const memoryModule = moduleOf('memory', { permissions: ['memory.read'] }, async (ctx) => {
      const api = (ctx as { api?: { memory?: unknown } }).api
      memoryApi = api?.memory
    })
    const registry = new PetalRegistry()
    registry.register(memoryModule)
    // 宿主给了 memory.write，但模块只声明 memory.read
    const host = new ModuleHost(registry, new PermissionBroker(['memory.read', 'memory.write']), {
      root,
      hostCapabilities: FULL_HOST
    })

    await host.start('memory')

    const memory = memoryApi as { read?: unknown; write?: unknown }
    expect(typeof memory.read).toBe('function')
    expect(memory.write).toBeUndefined()
  })
})

describe('S3 占位与状态同步', () => {
  it('占位 handle 的 teardown 在 stop 时被调用', async () => {
    const broken = moduleOf('broken', {}, async () => {
      throw new Error('boom')
    })
    const tornDown: string[] = []
    const { host } = build([{ module: broken }], FULL_HOST, (info) => ({
      teardown: () => {
        tornDown.push(info.id)
      }
    }))

    await host.start('broken')
    expect(host.placeholderIds()).toEqual(['broken'])

    await host.stop('broken')
    expect(tornDown).toEqual(['broken'])
    expect(host.placeholderIds()).toEqual([])
  })

  it('反复失败不堆积占位，旧卡先 teardown', async () => {
    const broken = moduleOf('broken', {}, async () => {
      throw new Error('boom')
    })
    let tornDown = 0
    const { host } = build([{ module: broken }], FULL_HOST, () => ({
      teardown: () => {
        tornDown += 1
      }
    }))

    await host.start('broken')
    await host.start('broken')
    await host.start('broken')

    expect(host.placeholderIds()).toEqual(['broken'])
    expect(tornDown).toBe(2)
  })

  it('failed 状态与占位一一对应，running/disabled 不留占位', async () => {
    const broken = moduleOf('broken', {}, async () => {
      throw new Error('boom')
    })
    const fine = moduleOf('fine')
    const off = moduleOf('off')
    const { host } = build(
      [
        { module: broken },
        { module: fine },
        { module: off, config: { enabled: false } }
      ],
      FULL_HOST
    )

    await host.startAll()

    const failed = host
      .statuses()
      .filter((runtime) => runtime.status === 'failed')
      .map((runtime) => runtime.id)
      .sort()
    expect([...host.placeholderIds()].sort()).toEqual(failed)
    expect(failed).toEqual(['broken'])
  })
})

describe('S3 ModuleLoader 接入：懒加载与超时降级', () => {
  it('注册表没有的模块走 loader，成功后 running', async () => {
    const registry = new PetalRegistry()
    const loader = createRegistryModuleLoader([['lazy', async () => moduleOf('lazy')]])
    const host = new ModuleHost(registry, new PermissionBroker(), {
      root,
      hostCapabilities: FULL_HOST,
      loader
    })

    expect(await host.start('lazy')).toBe(true)
    expect(statusOf(host, 'lazy')).toBe('ready')
    expect(registry.get('lazy')).toBeDefined()
  })

  it('loader 超时 → failed + LOAD_TIMEOUT + 占位', async () => {
    const registry = new PetalRegistry()
    const loader = createRegistryModuleLoader([['slow', () => new Promise<IPetalModule>(() => {})]], {
      timeoutMs: 10
    })
    const placed: string[] = []
    const host = new ModuleHost(registry, new PermissionBroker(), {
      root,
      hostCapabilities: FULL_HOST,
      loader,
      timeoutMs: 10,
      placeholder: (info) => {
        placed.push(info.id)
      }
    })

    expect(await host.start('slow')).toBe(false)
    expect(host.statuses()[0]).toMatchObject({ id: 'slow', status: 'failed', code: 'LOAD_TIMEOUT' })
    expect(placed).toEqual(['slow'])
  })

  it('一个模块加载超时，其余模块照常启动', async () => {
    const registry = new PetalRegistry()
    const loader = createRegistryModuleLoader(
      [
        ['slow', () => new Promise<IPetalModule>(() => {})],
        ['fine', async () => moduleOf('fine')]
      ],
      { timeoutMs: 10 }
    )
    const host = new ModuleHost(registry, new PermissionBroker(), {
      root,
      hostCapabilities: FULL_HOST,
      loader,
      timeoutMs: 10
    })

    await host.startAll()

    expect(statusOf(host, 'slow')).toBe('failed')
    expect(statusOf(host, 'fine')).toBe('ready')
  })
})

describe('S3 17.2.17 ③：停止顺序', () => {
  it('先 teardown 后移除占位：teardown 时容器还在', async () => {
    let aliveDuringTeardown = false
    let hostRef!: ModuleHost

    const module: IPetalModule = {
      meta: { id: 'boom', name: 'boom', version: '1.0.0', permissions: [], tier: 'general' },
      async bootstrap() {
        throw new Error('启动失败')
      },
      async teardown() {
        aliveDuringTeardown = hostRef.placeholderIds().includes('boom')
      }
    }

    const built = build([{ module }], FULL_HOST)
    hostRef = built.host

    await hostRef.startAll()
    expect(hostRef.placeholderIds()).toEqual(['boom'])

    await hostRef.stop('boom')

    expect(aliveDuringTeardown).toBe(true)
    expect(hostRef.placeholderIds()).toEqual([])
  })
})

describe('S3 DoD ②：六个开关的 2^6 组合全部无报错', () => {
  it('64 种组合逐个跑，状态与开关一致', async () => {
    for (let mask = 0; mask < 64; mask += 1) {
      const entries = Array.from({ length: 6 }, (_, index) => ({
        module: moduleOf(`m${index}`),
        config: { enabled: (mask & (1 << index)) !== 0 }
      }))

      const { host } = build(entries, FULL_HOST)
      const statuses = await host.startAll()

      expect(statuses).toHaveLength(6)
      for (let index = 0; index < 6; index += 1) {
        const expected = (mask & (1 << index)) !== 0 ? 'ready' : 'disabled'
        expect(statusOf(host, `m${index}`)).toBe(expected)
      }
    }
  })
})

describe('S3 ③-c：降级模式的消费方（三断言）', () => {
  it('纯插件形态：tray/window 不适用 → 静默不启、不占位、不记失败', async () => {
    const trayMenu = moduleOf('tray-menu', { hostCapabilities: ['tray', 'window'] as const satisfies readonly HostCapability[] })
    const { host, placed } = build([{ module: trayMenu }], {
      version: '0.2.1',
      available: [] as const satisfies readonly HostCapability[],
      notApplicable: ['tray', 'window'] as const satisfies readonly HostCapability[]
    })

    expect(await host.start('tray-menu')).toBe(false)

    // ① 快照标为不适用，且不产生占位
    expect(placed).toEqual([])
    expect(host.placeholderIds()).toEqual([])

    // ② 状态是 degraded，不是 failed —— 诊断面板不该长期报红
    expect(statusOf(host, 'tray-menu')).toBe('degraded')
    expect(host.statuses()[0]).toMatchObject({ code: 'HOST_NOT_APPLICABLE' })
  })

  it('silent 能力缺失：degraded + degradeMode=silent，不占位', async () => {
    const voice = moduleOf('voice', { hostCapabilities: ['voiceInput'] as const satisfies readonly HostCapability[] })
    const { host, placed } = build([{ module: voice }], { version: '0.2.1', available: [] as const satisfies readonly HostCapability[] })

    await host.start('voice')

    expect(statusOf(host, 'voice')).toBe('degraded')
    expect(host.statuses()[0]?.degradeMode).toBe('silent')
    expect(placed).toEqual([])
  })

  it('placeholder 能力缺失：仍走 failed + 占位，可见降级不被静默吞掉', async () => {
    const asker = moduleOf('asker', { hostCapabilities: ['ask'] as const satisfies readonly HostCapability[] })
    const { host, placed } = build([{ module: asker }], { version: '0.2.1', available: [] as const satisfies readonly HostCapability[] })

    await host.start('asker')

    expect(statusOf(host, 'asker')).toBe('failed')
    expect(placed).toHaveLength(1)
  })

  it('多能力缺失取最严重的模式：silent + readonly → readonly', async () => {
    const mixed = moduleOf('mixed', { hostCapabilities: ['tray', 'sessionRead'] as const satisfies readonly HostCapability[] })
    const { host } = build([{ module: mixed }], { version: '0.2.1', available: [] as const satisfies readonly HostCapability[] })

    await host.start('mixed')

    expect(statusOf(host, 'mixed')).toBe('degraded')
    expect(host.statuses()[0]?.degradeMode).toBe('readonly')
  })

  it('严重度与声明顺序无关：两种顺序都取 fixed，排除取首项/末项', async () => {
    const forward = moduleOf('forward', { hostCapabilities: ['tray', 'window'] as const satisfies readonly HostCapability[] })
    const backward = moduleOf('backward', { hostCapabilities: ['window', 'tray'] as const satisfies readonly HostCapability[] })
    const { host } = build([{ module: forward }, { module: backward }], {
      version: '0.2.1',
      available: [] as const satisfies readonly HostCapability[]
    })

    await host.startAll()

    const byId = new Map(host.statuses().map((runtime) => [runtime.id, runtime]))
    expect(byId.get('forward')?.degradeMode).toBe('fixed')
    expect(byId.get('backward')?.degradeMode).toBe('fixed')
  })

  it('placeholder 优先于其他模式：ask + tray → placeholder 占位', async () => {
    const mixed = moduleOf('mixed', { hostCapabilities: ['ask', 'tray'] as const satisfies readonly HostCapability[] })
    const { host, placed } = build([{ module: mixed }], { version: '0.2.1', available: [] as const satisfies readonly HostCapability[] })

    await host.start('mixed')

    expect(statusOf(host, 'mixed')).toBe('failed')
    expect(placed).toHaveLength(1)
  })

  it('纯插件形态：判定结果 reason 为 not-applicable，且不产生 missing', () => {
    const meta = moduleOf('tray-menu', { hostCapabilities: ['tray', 'window'] as const satisfies readonly HostCapability[] }).meta

    const result = evaluateModuleHost(meta, {
      version: '0.2.1',
      available: [] as const satisfies readonly HostCapability[],
      notApplicable: ['tray', 'window'] as const satisfies readonly HostCapability[]
    })

    expect(result.reason).toBe('not-applicable')
    expect(result.missing).toEqual([])
    expect(result.notApplicable).toEqual(['tray', 'window'])
    expect(result.degradeMode).toBeUndefined()
  })
})

describe('S3 ③-d：fixed 与 readonly 的行为（不只看字段）', () => {
  it('fixed：按固定画布输出，宿主窗口接口一次都没调用', async () => {
    const registry = new PetalRegistry()
    registry.register(
      moduleOf('win', { hostCapabilities: ['window'] as const satisfies readonly HostCapability[] })
    )

    const shellCalls: string[] = []
    const host = new ModuleHost(registry, new PermissionBroker(), {
      root,
      hostCapabilities: { version: '0.2.1', available: [] as const satisfies readonly HostCapability[] },
      shell: { resizeToContent: () => shellCalls.push('resizeToContent') }
    })

    await host.start('win')

    expect(statusOf(host, 'win')).toBe('degraded')
    expect(host.statuses()[0]?.degradeMode).toBe('fixed')
    expect(host.applyLayout('win')).toEqual({ mode: 'fixed-canvas', width: 300, height: 150 })
    expect(shellCalls).toHaveLength(0)
  })

  it('readonly：写入被拒并给出原因，写函数一次都没执行', async () => {
    const registry = new PetalRegistry()
    registry.register(
      moduleOf('cfg', { hostCapabilities: ['settings'] as const satisfies readonly HostCapability[] })
    )

    const host = new ModuleHost(registry, new PermissionBroker(), {
      root,
      hostCapabilities: { version: '0.2.1', available: [] as const satisfies readonly HostCapability[] }
    })

    await host.start('cfg')
    expect(host.statuses()[0]?.degradeMode).toBe('readonly')

    let writes = 0
    const result = host.requestWrite('cfg', () => {
      writes += 1
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.code).toBe('READONLY_DEGRADED')
    expect(result.message.length).toBeGreaterThan(0)
    expect(writes).toBe(0)
  })

  it('能力齐备：布局交给宿主，写入正常执行', async () => {
    const registry = new PetalRegistry()
    registry.register(
      moduleOf('ok', {
        hostCapabilities: ['window', 'settings'] as const satisfies readonly HostCapability[]
      })
    )

    const shellCalls: string[] = []
    const host = new ModuleHost(registry, new PermissionBroker(), {
      root,
      hostCapabilities: {
        version: '0.2.1',
        available: ['window', 'settings'] as const satisfies readonly HostCapability[]
      },
      shell: { resizeToContent: () => shellCalls.push('resizeToContent') }
    })

    await host.start('ok')

    expect(statusOf(host, 'ok')).toBe('ready')
    expect(host.applyLayout('ok')).toEqual({ mode: 'host-managed' })
    expect(shellCalls).toHaveLength(1)

    let writes = 0
    expect(
      host.requestWrite('ok', () => {
        writes += 1
      })
    ).toEqual({ ok: true })
    expect(writes).toBe(1)
  })
})

describe('1.4 依赖声明：缺依赖只降级自己', () => {
  const NO_CAP = { version: '0.2.0', available: [] as const }

  it('依赖未启动 → degraded 并写明缺谁，不占位', async () => {
    const { host, placed } = build(
      [{ module: moduleOf('app', { requires: ['base'] }) }, { module: moduleOf('base') }],
      NO_CAP
    )

    expect(await host.start('app')).toBe(false)
    expect(statusOf(host, 'app')).toBe('degraded')

    const runtime = host.statuses().find((item) => item.id === 'app')
    expect(runtime?.code).toBe('DEPENDENCY_MISSING')
    expect(runtime?.message).toContain('base=unregistered')
    expect(placed).toHaveLength(0)
  })

  it('依赖就绪后可以正常启动', async () => {
    const { host } = build(
      [{ module: moduleOf('base') }, { module: moduleOf('app', { requires: ['base'] }) }],
      NO_CAP
    )

    expect(await host.start('base')).toBe(true)
    expect(await host.start('app')).toBe(true)
    expect(statusOf(host, 'app')).toBe('ready')
  })

  it('依赖被停掉后，重新启动退回降级而不是崩', async () => {
    const { host } = build(
      [{ module: moduleOf('base') }, { module: moduleOf('app', { requires: ['base'] }) }],
      NO_CAP
    )

    await host.start('base')
    await host.start('app')
    await host.stop('base')

    expect(await host.start('app')).toBe(false)
    const runtime = host.statuses().find((item) => item.id === 'app')
    expect(runtime?.code).toBe('DEPENDENCY_MISSING')
    expect(runtime?.message).toContain('base=stopped')
  })
})

describe('1.3 故障隔离：runGuarded 只牵连自己', () => {
  const NO_CAP = { version: '0.2.0', available: [] as const }

  it('回调抛错 → 该模块 failed，兄弟模块仍是 ready', async () => {
    const { host, placed } = build([{ module: moduleOf('a') }, { module: moduleOf('b') }], NO_CAP)
    await host.start('a')
    await host.start('b')

    const ok = host.runGuarded('a', () => {
      throw new Error('回调炸了')
    })

    expect(ok).toBe(false)
    expect(statusOf(host, 'a')).toBe('failed')
    expect(statusOf(host, 'b')).toBe('ready')
    expect(placed.map((item) => item.id)).toEqual(['a'])
  })

  it('已停止的模块再抛错只留痕，不改状态', async () => {
    const { host } = build([{ module: moduleOf('a') }], NO_CAP)
    await host.start('a')
    await host.stop('a')

    expect(
      host.runGuarded('a', () => {
        throw new Error('清理残留')
      })
    ).toBe(false)
    expect(statusOf(host, 'a')).toBe('stopped')
  })

  it('未注册的模块直接返回 false', () => {
    const { host } = build([], NO_CAP)
    expect(host.runGuarded('nope', () => {})).toBe(false)
  })
})

describe('1.7 关闭即卸载', () => {
  const NO_CAP = { version: '0.2.0', available: [] as const }

  function moduleWithCleaners(id: string, onClean?: () => void): IPetalModule {
    return {
      meta: { id, name: id, version: '1.0.0', permissions: [], tier: 'general' },
      async bootstrap(ctx) {
        ctx.disposers.add(() => {
          onClean?.()
        })
      },
      async teardown() {}
    }
  }

  it('stop 会跑光模块登记的全部清理器', async () => {
    let released = 0
    const module: IPetalModule = {
      meta: { id: 'cleanup', name: 'cleanup', version: '1.0.0', permissions: [], tier: 'general' },
      async bootstrap(ctx) {
        ctx.disposers.add(() => {
          released += 1
        })
        ctx.disposers.add(() => {
          released += 1
        })
      },
      async teardown() {}
    }

    const { host } = build([{ module }], NO_CAP)
    await host.start('cleanup')
    expect(released).toBe(0)

    await host.stop('cleanup')
    expect(released).toBe(2)
  })

  it('重复 stop 幂等：清理器不会跑第二遍', async () => {
    let released = 0
    const { host } = build([{ module: moduleWithCleaners('idem', () => (released += 1)) }], NO_CAP)
    await host.start('idem')

    await host.stop('idem')
    await host.stop('idem')

    expect(released).toBe(1)
    expect(statusOf(host, 'idem')).toBe('stopped')
  })

  it('teardown 抛错也落到 stopped，不会卡在 stopping', async () => {
    const module: IPetalModule = {
      meta: { id: 'boom', name: 'boom', version: '1.0.0', permissions: [], tier: 'general' },
      async bootstrap() {},
      async teardown() {
        throw new Error('teardown 炸了')
      }
    }

    const { host } = build([{ module }], NO_CAP)
    await host.start('boom')

    expect(await host.stop('boom')).toBe(true)
    expect(statusOf(host, 'boom')).toBe('stopped')
  })
})

describe('1.8 核心模块失败即停服', () => {
  const NO_CAP = { version: '0.2.0', available: [] as const }

  function failing(id: string, tier: ModuleMeta['tier']): IPetalModule {
    return {
      meta: { id, name: id, version: '1.0.0', permissions: [], tier },
      async bootstrap() {
        throw new Error(`${id} 启动失败`)
      },
      async teardown() {}
    }
  }

  it('核心模块失败 → 服务停，原因带上模块 id', async () => {
    const reasons: ServiceStopReason[] = []
    const { host } = build(
      [{ module: failing('shell-core', 'core') }, { module: moduleOf('bubble', { tier: 'essential' }) }],
      NO_CAP,
      undefined,
      { onServiceStop: (reason) => reasons.push(reason) }
    )

    await host.startAll()

    expect(host.serviceState).toBe('stopped')
    expect(host.stopReason?.moduleId).toBe('shell-core')
    expect(host.stopReason?.message).toContain('启动失败')
    expect(reasons).toHaveLength(1)
    // 非核心模块照常起来：停服是宣布状态，不是立刻把所有人拉闸
    expect(statusOf(host, 'bubble')).toBe('ready')
  })

  it('一般模块失败不影响服务状态', async () => {
    const reasons: ServiceStopReason[] = []
    const { host } = build([{ module: failing('reminder', 'general') }], NO_CAP, undefined, {
      onServiceStop: (reason) => reasons.push(reason)
    })

    await host.startAll()

    expect(host.serviceState).toBe('running')
    expect(host.stopReason).toBeUndefined()
    expect(reasons).toHaveLength(0)
  })

  it('两个核心模块先后崩，只通知一次并保留首因', async () => {
    const reasons: ServiceStopReason[] = []
    const { host } = build(
      [{ module: failing('core-a', 'core') }, { module: failing('core-b', 'core') }],
      NO_CAP,
      undefined,
      { onServiceStop: (reason) => reasons.push(reason) }
    )

    await host.startAll()

    expect(reasons).toHaveLength(1)
    expect(host.stopReason?.moduleId).toBe('core-a')
  })
})
