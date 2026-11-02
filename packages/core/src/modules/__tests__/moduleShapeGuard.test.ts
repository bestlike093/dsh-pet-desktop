import { describe, expect, it } from 'vitest'
import { ErrorCode, isPetError } from '@pet/shared'
import type { HostCapability, IPetalModule } from '@pet/shared'
import { ModuleHost } from '../moduleHost.js'
import type { PlaceholderInfo } from '../moduleHost.js'
import { createRegistryModuleLoader } from '../moduleLoader.js'
import { PermissionBroker } from '../permissionBroker.js'
import { PetalRegistry, assertModuleShape } from '../petalRegistry.js'

const root = {} as ShadowRoot

/**
 * 上游踩过的那个形状：`{ inject, Page }`。
 * 宿主加载器会抛 `invalid plugin, expect function or object with an "apply" method`，
 * 发生在 renderer boot 阶段，会把整个界面带崩。
 */
function badShape(): unknown {
  return { inject: {}, Page: () => null }
}

function goodModule(id: string): IPetalModule {
  return {
    meta: { id, name: id, version: '1.0.0', permissions: [], tier: 'general' },
    bootstrap: async () => {},
    teardown: async () => {}
  }
}

function expectShapeError(fn: () => void): void {
  let caught: unknown
  try {
    fn()
  } catch (error) {
    caught = error
  }
  expect(caught).toBeDefined()
  expect(isPetError(caught)).toBe(true)
  expect((caught as { code: string }).code).toBe(ErrorCode.INVALID_ARGUMENT)
  expect((caught as Error).message).toContain('形状不对')
}

describe('模块形状校验：坏形状要说人话', () => {
  it('`{ inject, Page }` 被拦下，报错带「形状不对」而不是 Cannot read properties', () => {
    expectShapeError(() => assertModuleShape(badShape()))
  })

  it('null / 字符串 / 数字 都拦下', () => {
    expectShapeError(() => assertModuleShape(null))
    expectShapeError(() => assertModuleShape('module'))
    expectShapeError(() => assertModuleShape(42))
  })

  it('缺 meta 时明确说是缺 meta', () => {
    let message = ''
    try {
      assertModuleShape({ bootstrap: async () => {}, teardown: async () => {} })
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toContain('缺少 meta')
  })

  it('meta.id 为空字符串时拦下', () => {
    expectShapeError(() =>
      assertModuleShape({ meta: { id: '', name: 'x' }, bootstrap: () => {}, teardown: () => {} })
    )
  })

  it('缺 bootstrap 时点名 bootstrap', () => {
    let message = ''
    try {
      assertModuleShape({
        meta: { id: 'm', name: 'm', permissions: [] },
        teardown: async () => {}
      })
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toContain('bootstrap')
  })

  it('缺 teardown 时点名 teardown', () => {
    let message = ''
    try {
      assertModuleShape({
        meta: { id: 'm', name: 'm', permissions: [] },
        bootstrap: async () => {}
      })
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toContain('teardown')
  })

  it('缺 meta.permissions 时在注册前拦下，不留到 start 抛 TypeError', () => {
    let message = ''
    try {
      assertModuleShape({ meta: { id: 'm', name: 'm' }, bootstrap: async () => {}, teardown: async () => {} })
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toContain('meta.permissions')
  })

  it('meta.permissions 含未知权限时拦下', () => {
    let message = ''
    try {
      assertModuleShape({
        meta: { id: 'm', name: 'm', permissions: ['root-everything'] },
        bootstrap: async () => {},
        teardown: async () => {}
      })
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toContain('未知权限')
  })

  it('合法模块不抛', () => {
    expect(() => assertModuleShape(goodModule('ok'))).not.toThrow()
  })

  it('register 在写进表之前就拦下，坏模块不会占住 id', () => {
    const registry = new PetalRegistry()
    expectShapeError(() => registry.register(badShape() as IPetalModule))
    expect(registry.size).toBe(0)
  })
})

describe('模块形状校验：坏模块不拖累兄弟', () => {
  function hostWith(
    entries: readonly (readonly [string, () => unknown])[]
  ): { host: ModuleHost; placed: PlaceholderInfo[] } {
    const loader = createRegistryModuleLoader(
      entries.map(([id, factory]) => [id, () => factory() as IPetalModule] as const)
    )
    const placed: PlaceholderInfo[] = []
    const host = new ModuleHost(new PetalRegistry(), new PermissionBroker(), {
      root,
      loader,
      hostCapabilities: {
        version: '0.2.0',
        available: ['ask', 'approval', 'settings', 'tray', 'window'] as const satisfies readonly HostCapability[]
      },
      placeholder: (info) => {
        placed.push(info)
        return () => undefined
      }
    })
    return { host, placed }
  }

  it('start 坏模块返回 false，不抛到调用方', async () => {
    const { host } = hostWith([['bad', badShape]])
    await expect(host.start('bad')).resolves.toBe(false)
  })

  it('坏模块记为 failed，错误码是 INVALID_ARGUMENT，消息能看出是形状问题', async () => {
    const { host } = hostWith([['bad', badShape]])
    await host.start('bad')

    const runtime = host.statuses().find((item) => item.id === 'bad')
    expect(runtime?.status).toBe('failed')
    expect(runtime?.code).toBe(ErrorCode.INVALID_ARGUMENT)
    expect(runtime?.message).toContain('形状不对')
  })

  it('坏模块留占位，界面有东西可显示', async () => {
    const { host, placed } = hostWith([['bad', badShape]])
    await host.start('bad')
    expect(placed.map((info) => info.id)).toContain('bad')
  })

  it('坏模块之后，同批的好模块照常启动', async () => {
    const { host } = hostWith([
      ['bad', badShape],
      ['good', () => goodModule('good')]
    ])

    expect(await host.start('bad')).toBe(false)
    expect(await host.start('good')).toBe(true)
    expect(host.statuses().find((item) => item.id === 'good')?.status).toBe('ready')
  })

  it('startAll 遇到坏模块继续往下跑，不中断整轮', async () => {
    const { host } = hostWith([
      ['bad', badShape],
      ['good', () => goodModule('good')]
    ])

    const runtimes = await host.startAll()
    const byId = new Map(runtimes.map((item) => [item.id, item.status]))
    expect(byId.get('bad')).toBe('failed')
    expect(byId.get('good')).toBe('ready')
  })
})
