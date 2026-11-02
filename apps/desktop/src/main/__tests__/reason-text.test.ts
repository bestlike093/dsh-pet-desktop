import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

type ReasonTextApi = {
  voiceKey: (state: unknown) => string
  chat: (reason: unknown) => string
  unmappedCount: () => number
  resetUnmapped: () => void
}

function loadReasonText(): ReasonTextApi {
  const source = readFileSync(
    new URL('../../../electron/renderer/reason-text.js', import.meta.url),
    'utf8'
  )
  const sandbox: { window: { CyreneReasonText?: ReasonTextApi } } = { window: {} }
  runInNewContext(source, sandbox)
  return sandbox.window.CyreneReasonText as ReasonTextApi
}

describe('reason-text', () => {
  it('未知 chat 码返回非空兜底并计数', () => {
    const api = loadReasonText()
    expect(api.unmappedCount()).toBe(0)

    const text = api.chat('no-quota')
    expect(text.length).toBeGreaterThan(0)
    expect(text).toContain('no-quota')
    expect(api.unmappedCount()).toBe(1)
  })

  it('未知 voice 码落到 unknown key 并计数', () => {
    const api = loadReasonText()
    expect(api.voiceKey('no-such-state')).toBe('voice.state.unknown')
    expect(api.unmappedCount()).toBe(1)
  })

  it('resetUnmapped 只给测试归零，计数本身单调', () => {
    const api = loadReasonText()
    api.chat('nope-a')
    api.chat('nope-b')
    expect(api.unmappedCount()).toBe(2)

    api.resetUnmapped()
    expect(api.unmappedCount()).toBe(0)
  })

  it('chat.state.stale 是独立文案，不复用 voice 的 offline', () => {
    const api = loadReasonText()
    expect(api.chat('chat.state.stale')).toContain('上次状态')
    expect(api.chat('chat.state.stale')).not.toBe(api.voiceKey('offline'))
  })

  it('任意输入都不抛、不返回空串', () => {
    const api = loadReasonText()
    const inputs: unknown[] = [
      undefined,
      null,
      '',
      0,
      false,
      Symbol('x'),
      {
        toString() {
          throw new Error('boom')
        }
      }
    ]

    for (const input of inputs) {
      expect(() => api.chat(input)).not.toThrow()
      expect(api.chat(input).length).toBeGreaterThan(0)
      expect(() => api.voiceKey(input)).not.toThrow()
      expect(api.voiceKey(input)).toBe('voice.state.unknown')
    }
  })
})
