/** 测试用最小 DOM：只实现诊断面板真正用到的那几个方法。 */

export class FakeNode {
  readonly children: FakeNode[] = []
  textContent = ''
  className = ''
  readonly dataset: Record<string, string> = {}
  readonly attributes = new Map<string, string>()
  readonly listeners = new Map<string, Set<() => void>>()
  removed = false

  constructor(
    readonly tagName: string,
    readonly ownerDocument: FakeDocument | null
  ) {}

  append(...nodes: FakeNode[]): void {
    this.children.push(...nodes)
  }

  replaceChildren(): void {
    this.children.length = 0
  }

  remove(): void {
    this.removed = true
  }

  get childElementCount(): number {
    return this.children.length
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

  click(): void {
    for (const handler of [...(this.listeners.get('click') ?? [])]) handler()
  }
}

export class FakeDocument {
  createElement(tagName: string): FakeNode {
    return new FakeNode(tagName, this)
  }
}

export function createFakeContainer(): FakeNode {
  return new FakeNode('div', new FakeDocument())
}

/** 模拟已从文档摘除、ownerDocument 为 null 的容器。 */
export function createDetachedContainer(): FakeNode {
  return new FakeNode('div', null)
}

export function collectText(node: FakeNode): string {
  return [node.textContent, ...node.children.map(collectText)].filter((part) => part.length > 0).join('\n')
}

export function findButtons(node: FakeNode): FakeNode[] {
  const own = node.tagName === 'button' ? [node] : []
  return [...own, ...node.children.flatMap(findButtons)]
}
