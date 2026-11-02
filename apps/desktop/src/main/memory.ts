// 记忆摘要（从 electron/main.mjs 迁出，存储与历史由调用方注入）。
//
// 只把「内存里已经没有了」的更早片段送进提示词。
// 当前会话的历史本来就跟着请求走，重复塞一遍只会白占预算。

export interface MemoryTurn {
  role: string
  text: string
}

export interface MemoryDigestInput {
  enabled: boolean
  available: boolean
  count: number
  items: ReadonlyArray<MemoryTurn>
  historyLength: number
}

export function buildMemoryDigest(input: MemoryDigestInput): string {
  if (!input.enabled) return ''
  if (!input.available || input.count === 0) return ''
  const items = input.items
  const overlap = Math.min(input.historyLength, items.length)
  const older = items.slice(0, items.length - overlap)
  if (older.length === 0) return ''
  return older.map((item) => `${item.role === 'user' ? '用户' : '你'}：${item.text}`).join('\n')
}
