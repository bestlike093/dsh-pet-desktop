import { describe, expect, it } from 'vitest'
import type { DiagnosticsSnapshot } from '../diagnostics.js'
import { mountDiagnosticsPanel } from '../panelDom.js'
import { collectText, createDetachedContainer, createFakeContainer, findButtons, type FakeNode } from './fakeDom.js'

function mountAt(onRetry?: () => void): { mount: ReturnType<typeof mountDiagnosticsPanel>; root: FakeNode } {
  const container = createFakeContainer()
  const mount = mountDiagnosticsPanel(
    container as unknown as Element,
    onRetry === undefined ? {} : { onRetry }
  )
  return { mount, root: mount.element as unknown as FakeNode }
}

function snapshot(): DiagnosticsSnapshot {
  return {
    version: '2.0.0',
    generatedAt: 1000,
    ok: false,
    bridge: 'connected',
    sections: [
      { name: 'vault', ok: false, level: 'error', code: 'VAULT_LOCKED', data: { group: 'credential', kind: 'secure' } }
    ]
  }
}

describe('诊断面板 DOM 外壳', () => {
  it('pending 时不出现任何「已就绪」符号', () => {
    const { mount, root } = mountAt()

    mount.update({ kind: 'pending' })
    const text = collectText(root)

    expect(root.dataset.state).toBe('pending')
    expect(text).toContain('尚未返回')
    for (const mark of ['✅', '✓', '✔', '[OK]', '已就绪']) {
      expect(text).not.toContain(mark)
    }
  })

  it('pending 期间没有覆盖层，重试按钮仍可点', () => {
    let retried = 0
    const { mount, root } = mountAt(() => {
      retried += 1
    })

    mount.update({ kind: 'pending' })

    // 根节点只有 style / head / body，没有额外的遮罩层。
    expect(root.children).toHaveLength(3)
    for (const node of [root, ...root.children]) {
      expect(node.className).not.toMatch(/overlay|mask|loading/i)
      expect(node.attributes.has('data-blocking')).toBe(false)
    }

    const [retry] = findButtons(root)
    expect(retry).toBeDefined()
    retry?.click()
    expect(retried).toBe(1)
  })

  it('容器已脱离文档：不建节点、不写 state、不抛错', () => {
    const container = createDetachedContainer()
    const mount = mountDiagnosticsPanel(container as unknown as Element)

    expect(mount.element).toBeNull()
    expect(() => mount.update({ kind: 'pending' })).not.toThrow()
    expect(() => mount.dispose()).not.toThrow()
    expect(container.children).toHaveLength(0)
    expect(container.dataset.state).toBeUndefined()
  })

  it('ready 后按 group → kind 渲染', () => {
    const { mount, root } = mountAt()

    mount.update({ kind: 'ready', snapshot: snapshot() })
    const text = collectText(root)

    expect(root.dataset.state).toBe('ready')
    expect(text).toContain('credential')
    expect(text).toContain('secure')
    expect(text).toContain('VAULT_LOCKED')
    expect(text).toContain('fix')
  })

  it('dispose 后节点与按钮监听器一起摘掉', () => {
    const { mount, root } = mountAt(() => {})

    mount.dispose()

    expect(root.removed).toBe(true)
    expect(root.listeners.get('click')?.size ?? 0).toBe(0)
    for (const child of root.children) {
      expect(child.listeners.get('click')?.size ?? 0).toBe(0)
    }
  })
})
