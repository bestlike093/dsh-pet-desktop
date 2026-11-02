import { describe, expect, it } from 'vitest'
import type { DisposerRegistry } from '@pet/shared'
import { createDisposerRegistry } from '../disposer.js'
import { createPlaceholderCard } from '../placeholderCard.js'

class FakeElement {
  readonly tagName: string
  readonly children: FakeElement[] = []
  readonly attributes = new Map<string, string>()
  readonly dataset: Record<string, string> = {}
  readonly style: { cssText: string } = { cssText: '' }
  readonly listeners = new Map<string, Set<() => void>>()
  textContent = ''
  className = ''
  type = ''
  removed = false

  constructor(tagName: string) {
    this.tagName = tagName
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value)
  }

  addEventListener(type: string, handler: () => void): void {
    const set = this.listeners.get(type) ?? new Set<() => void>()
    set.add(handler)
    this.listeners.set(type, set)
  }

  removeEventListener(type: string, handler: () => void): void {
    this.listeners.get(type)?.delete(handler)
  }

  append(...nodes: FakeElement[]): void {
    this.children.push(...nodes)
  }

  remove(): void {
    this.removed = true
  }

  get childElementCount(): number {
    return this.children.length
  }

  click(): void {
    for (const handler of [...(this.listeners.get('click') ?? [])]) handler()
  }
}

function fakeDocument(): Document {
  return {
    createElement: (tagName: string) => new FakeElement(tagName)
  } as unknown as Document
}

function buttons(card: FakeElement): FakeElement[] {
  return card.children.flatMap((child) => child.children.filter((node) => node.tagName === 'button'))
}

const info = { id: 'approval', name: '审批', code: 'LOAD_FAILED', message: '启动失败' }

describe('宿主占位卡', () => {
  it('重试 / 诊断按钮各自触发一次', () => {
    let retried = 0
    let diagnosed = 0
    const card = createPlaceholderCard({
      document: fakeDocument(),
      info,
      onRetry: () => {
        retried += 1
      },
      onDiagnose: () => {
        diagnosed += 1
      }
    })

    const [retry, diagnose] = buttons(card.element as unknown as FakeElement)
    retry?.click()
    diagnose?.click()

    expect(retried).toBe(1)
    expect(diagnosed).toBe(1)
  })

  it('teardown 先摘监听器再移除节点', () => {
    let retried = 0
    const card = createPlaceholderCard({
      document: fakeDocument(),
      info,
      onRetry: () => {
        retried += 1
      }
    })

    const element = card.element as unknown as FakeElement
    card.teardown()

    buttons(element)[0]?.click()
    expect(retried).toBe(0)
    expect(element.removed).toBe(true)
  })

  it('监听器随 disposer 一起释放', () => {
    let retried = 0
    const disposers: DisposerRegistry = createDisposerRegistry()
    const card = createPlaceholderCard({
      document: fakeDocument(),
      info,
      disposers,
      onRetry: () => {
        retried += 1
      }
    })

    const element = card.element as unknown as FakeElement
    disposers.disposeAll()

    buttons(element)[0]?.click()
    expect(retried).toBe(0)
    expect(element.removed).toBe(true)
  })

  it('样式自足：内联样式只读宿主变量，不依赖模块样式表', () => {
    const card = createPlaceholderCard({ document: fakeDocument(), info })
    const element = card.element as unknown as FakeElement

    expect(element.style.cssText).toContain('--dsh-placeholder-border')
    expect(element.style.cssText).toContain('#fff7fa')
    for (const child of element.children) {
      expect(child.style.cssText.length).toBeGreaterThan(0)
    }
  })
})
