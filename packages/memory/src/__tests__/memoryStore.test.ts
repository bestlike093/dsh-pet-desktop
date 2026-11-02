import { describe, expect, it } from 'vitest'
import { MemoryStore, estimateTokens } from '../memoryStore.js'

describe('estimateTokens：CJK 与 ASCII 分流', () => {
  it('纯 ASCII 按 4 字符 ≈ 1 token', () => {
    expect(estimateTokens('abcdefgh')).toBe(2)
  })

  it('纯中文按 1 字符 ≈ 1 token', () => {
    expect(estimateTokens('你好世界')).toBe(4)
  })

  it('中英混合分别估算后取整', () => {
    expect(estimateTokens('你好abcd')).toBe(3)
  })
})

describe('summarize：await 期间新增的 turn 不被吞掉', () => {
  it('只清掉摘要快照覆盖的前 n 条，新 turn 保留', async () => {
    let release: (text: string) => void = () => undefined
    const gate = new Promise<string>((resolve) => {
      release = resolve
    })

    const store = new MemoryStore({
      deviceId: 'test-device',
      summarizer: async () => gate
    })
    store.addTurn('s1', { role: 'user', content: '第一句' })
    store.addTurn('s1', { role: 'user', content: '第二句' })

    const pending = store.summarize('s1', true)
    store.addTurn('s1', { role: 'user', content: '摘要期间的新消息' })
    release('摘要文本')
    await pending

    expect(store.turnsOf('s1').map((turn) => turn.content)).toEqual(['摘要期间的新消息'])
  })
})
