import { describe, expect, it, vi } from 'vitest'
import type { ModuleConfig, PanelSpec } from '@pet/shared'
import { createSandboxContext, installRealmNetworkGuard } from '../moduleSandbox.js'

const root = {} as ShadowRoot

const config: ModuleConfig = { enabled: true, granted: [], options: {} }

function sandbox(granted: ModuleConfig['granted'], ports = {}) {
  return createSandboxContext({ root, config, granted, ports })
}

describe('沙箱 ui 接口按权限逐项挂载', () => {
  it('只授予 ui.render 时没有 panel', () => {
    const ctx = sandbox(['ui.render'], { render: () => {} })
    expect(typeof ctx.api.ui?.render).toBe('function')
    expect(ctx.api.ui?.panel).toBeUndefined()
  })

  it('只授予 ui.panel 时没有 render', () => {
    const ctx = sandbox(['ui.panel'], { registerPanel: () => () => {} })
    expect(ctx.api.ui?.render).toBeUndefined()
    expect(typeof ctx.api.ui?.panel?.register).toBe('function')
  })

  it('两项都授予时同时存在', () => {
    const ctx = sandbox(['ui.render', 'ui.panel'], {
      render: () => {},
      registerPanel: () => () => {}
    })
    expect(typeof ctx.api.ui?.render).toBe('function')
    expect(typeof ctx.api.ui?.panel?.register).toBe('function')
  })

  it('两项都没授予时整个 ui 不存在', () => {
    const ctx = sandbox([])
    expect(ctx.api.ui).toBeUndefined()
  })
})

describe('模块拿到的上下文不可被就地扩权', () => {
  it('context / api / granted 都是冻结的', () => {
    const ctx = sandbox(['ui.render'], { render: () => {} })

    expect(Object.isFrozen(ctx)).toBe(true)
    expect(Object.isFrozen(ctx.api)).toBe(true)
    expect(Object.isFrozen(ctx.api.ui)).toBe(true)
    expect(Object.isFrozen(ctx.granted)).toBe(true)
    expect(Object.isFrozen(ctx.config)).toBe(true)
  })

  it('模块改不掉已挂载的接口', () => {
    const ctx = sandbox(['ui.render'], { render: () => {} })

    expect(() => {
      // @ts-expect-error 测试故意越权写入
      ctx.api.ui.render = () => {}
    }).toThrow()
    expect(() => {
      // @ts-expect-error 测试故意越权写入
      ctx.api.net = { fetch: async () => ({}) }
    }).toThrow()
    expect(ctx.api.net).toBeUndefined()
  })
})

describe('主 realm 网络遮蔽', () => {
  it('未授予 net.egress 时 fetch 不可调用，结束后还原', () => {
    const target: Record<string, unknown> = { fetch: () => 'real' }
    const restore = installRealmNetworkGuard({ allowNetwork: false, target })

    expect(() => (target['fetch'] as () => unknown)()).toThrowError(
      expect.objectContaining({ code: 'PERMISSION_DENIED' })
    )
    // 模块自己写回去也不生效
    target['fetch'] = () => 'hacked'
    expect(() => (target['fetch'] as () => unknown)()).toThrowError(
      expect.objectContaining({ code: 'PERMISSION_DENIED' })
    )

    restore()
    expect((target['fetch'] as () => unknown)()).toBe('real')
  })

  it('授予 net.egress 时保持原样', () => {
    const target: Record<string, unknown> = { fetch: () => 'real' }
    const restore = installRealmNetworkGuard({ allowNetwork: true, target })

    expect((target['fetch'] as () => unknown)()).toBe('real')
    restore()
    expect((target['fetch'] as () => unknown)()).toBe('real')
  })
})

describe('侧边栏面板注册', () => {
  const spec: PanelSpec = {
    id: 'session-log',
    title: '会话记录',
    order: 20,
    html: '<div class="panel">记录</div>'
  }

  it('把面板规格原样交给宿主端口，并返回注销函数', () => {
    const unregister = vi.fn()
    const registerPanel = vi.fn(() => unregister)
    const ctx = sandbox(['ui.panel'], { registerPanel })

    const dispose = ctx.api.ui?.panel?.register(spec)

    expect(registerPanel).toHaveBeenCalledWith(spec)
    expect(dispose).toBe(unregister)
  })

  it('宿主没提供 registerPanel 端口时抛 NOT_SUPPORTED', () => {
    const ctx = sandbox(['ui.panel'], {})
    expect(() => ctx.api.ui?.panel?.register(spec)).toThrowError(
      expect.objectContaining({ code: 'NOT_SUPPORTED' })
    )
  })

  it('模块拿到的只有 HTML，没有宿主 DOM 引用', () => {
    const registerPanel = vi.fn((_spec: PanelSpec) => () => {})
    const ctx = sandbox(['ui.panel'], { registerPanel })
    ctx.api.ui?.panel?.register(spec)

    const passed = registerPanel.mock.calls[0]?.[0]
    expect(passed).toBeDefined()
    expect(Object.keys(passed ?? {}).sort()).toEqual(['html', 'id', 'order', 'title'])
    expect(passed?.html).toBe(spec.html)
  })
})
