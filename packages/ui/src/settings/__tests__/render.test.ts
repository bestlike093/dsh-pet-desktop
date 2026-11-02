/**
 * 凭据字段的行为测试（V1 / V10 / V3）。
 *
 * 不起 jsdom：renderSettings 只用到 createElement / appendChild /
 * addEventListener / removeEventListener / querySelector，用一个极简 fake 足够。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsRegistryV1 } from '../registry.js'
import { isSensitiveField, renderSettings } from '../render.js'
import type { RenderHandleV1, RenderOptionsV1 } from '../render.js'
import type { SettingsFieldV1 } from '../types.js'

class FakeEl {
  className = ''
  id = ''
  type = ''
  value = ''
  placeholder = ''
  htmlFor = ''
  disabled = false
  hidden = false
  textContent = ''
  readonly dataset: Record<string, string> = {}
  readonly children: FakeEl[] = []
  private readonly listeners = new Map<string, Array<() => void>>()

  constructor(readonly tagName: string) {}

  appendChild(child: FakeEl): FakeEl {
    this.children.push(child)
    return child
  }

  addEventListener(type: string, fn: () => void): void {
    const list = this.listeners.get(type) ?? []
    list.push(fn)
    this.listeners.set(type, list)
  }

  removeEventListener(type: string, fn: () => void): void {
    const list = this.listeners.get(type)
    if (list === undefined) return
    const index = list.indexOf(fn)
    if (index >= 0) list.splice(index, 1)
  }

  dispatch(type: string): void {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn()
  }

  listenerCount(): number {
    let total = 0
    for (const list of this.listeners.values()) total += list.length
    return total
  }

  querySelector(selector: string): FakeEl | null {
    if (selector === '[data-role="error"]') {
      return this.children.find((c) => c.dataset['role'] === 'error') ?? null
    }
    return null
  }

  /** 深度优先找 id 匹配的输入控件 */
  findById(id: string): FakeEl | undefined {
    if (this.id === id) return this
    for (const child of this.children) {
      const hit = child.findById(id)
      if (hit !== undefined) return hit
    }
    return undefined
  }

  findByRole(role: string): FakeEl | undefined {
    if (this.dataset['role'] === role) return this
    for (const child of this.children) {
      const hit = child.findByRole(role)
      if (hit !== undefined) return hit
    }
    return undefined
  }
}

let root: FakeEl

beforeEach(() => {
  root = new FakeEl('div')
  vi.stubGlobal('document', {
    createElement: (tag: string) => new FakeEl(tag)
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function makeRegistry(): SettingsRegistryV1 {
  const r = new SettingsRegistryV1()
  r.registerGroup({ id: 'account', label: '账号', order: 10 })
  r.registerGroup({ id: 'font', label: '字体', order: 20 })
  r.register({
    id: 'account.apiKey',
    group: 'account',
    label: 'API Key',
    kind: 'key',
    order: 10,
    sensitive: true
  })
  r.register({
    id: 'font.family',
    group: 'font',
    label: '字体',
    kind: 'text',
    order: 10
  })
  return r
}

function render(options: RenderOptionsV1 = {}): RenderHandleV1 {
  return renderSettings(root as unknown as HTMLElement, makeRegistry(), options)
}

describe('E2 凭据字段：从不持有', () => {
  it('read() 的键集合恰等于全部非敏感字段（V1 恰等）', () => {
    const registry = makeRegistry()
    const handle = renderSettings(root as unknown as HTMLElement, registry, {})
    const input = root.findById('settings-account.apiKey')
    input!.value = 'sk-should-never-be-kept'
    input!.dispatch('input')

    // 恰等：新增任何敏感字段忘了走回调，这条立刻红
    const expected = new Set(
      registry
        .list()
        .filter((f) => !isSensitiveField(f))
        .map((f) => f.id)
    )
    expect(new Set(Object.keys(handle.read()))).toEqual(expected)
  })

  it('敏感字段的值不会出现在 read() 的任何位置', () => {
    const handle = render()
    const input = root.findById('settings-account.apiKey')
    input!.value = 'sk-should-never-be-kept'
    input!.dispatch('input')

    expect(Object.values(handle.read()).includes('sk-should-never-be-kept')).toBe(false)
  })

  it('敏感输入经回调交给上层', () => {
    const seen: Array<[string, string]> = []
    render({ onSensitiveInput: (id, raw) => seen.push([id, raw]) })

    const input = root.findById('settings-account.apiKey')
    input!.value = 'sk-abc'
    input!.dispatch('input')

    expect(seen).toEqual([['account.apiKey', 'sk-abc']])
  })

  it('敏感输入框从不回填', () => {
    render({ initial: { 'account.apiKey': 'sk-preloaded' } })
    const input = root.findById('settings-account.apiKey')
    expect(input!.value).toBe('')
  })

  it('非敏感字段仍然写进 read()', () => {
    const handle = render()
    const input = root.findById('settings-font.family')
    input!.value = 'Source Han Sans SC'
    input!.dispatch('input')

    expect(handle.read()['font.family']).toBe('Source Han Sans SC')
  })

  it('placeholder 只表达状态，不含 key 片段', () => {
    render({ sensitiveStatus: { 'account.apiKey': { saved: true, savedAt: '今天 21:30' } } })
    const input = root.findById('settings-account.apiKey')
    expect(input!.placeholder).toContain('已保存')
    expect(input!.placeholder).not.toContain('sk-')

    const status = root.findByRole('status')
    expect(status?.textContent).toBe('已保存 · 今天 21:30')
  })

  it('未保存时 placeholder 与状态行都是「未设置」', () => {
    render()
    const input = root.findById('settings-account.apiKey')
    expect(input!.placeholder).toBe('未设置')
    expect(root.findByRole('status')?.textContent).toBe('未设置')
  })

  it('dispose 清掉全部监听器', () => {
    const handle = render()
    const input = root.findById('settings-account.apiKey')
    expect(input!.listenerCount()).toBe(1)

    handle.dispose()
    expect(input!.listenerCount()).toBe(0)
  })
})

describe('E2 凭据字段：判定与路径', () => {
  it('sensitive: true 或 kind: key 都算敏感', () => {
    const byFlag: SettingsFieldV1 = {
      id: 'a',
      group: 'g',
      label: 'A',
      kind: 'text',
      sensitive: true
    }
    const byKind: SettingsFieldV1 = { id: 'b', group: 'g', label: 'B', kind: 'key' }
    const plain: SettingsFieldV1 = { id: 'c', group: 'g', label: 'C', kind: 'text' }

    expect(isSensitiveField(byFlag)).toBe(true)
    expect(isSensitiveField(byKind)).toBe(true)
    expect(isSensitiveField(plain)).toBe(false)
  })

  it('渲染句柄不提供读取凭据的成员（V3：断言路径不存在）', () => {
    const handle = render()
    // @ts-expect-error 刻意不提供 readSensitive —— 路径不存在，不是返回空
    expect(handle.readSensitive).toBeUndefined()
  })
})
