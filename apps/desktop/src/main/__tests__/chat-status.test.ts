import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { CHAT_STATUS_TTL_MS, registerChatStatus, type ChatStatusDeps } from '../ipc/queries/chat-status.js'
import { shortCircuit } from './helpers/short-circuit.js'

type Listener = (...args: unknown[]) => unknown
type Snapshot = Record<string, unknown> | null

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function createHarness(options: {
  snapshot?: Snapshot
  probe?: () => Promise<Record<string, unknown>>
  now?: () => number
} = {}) {
  let listener: Listener = () => undefined
  let snapshot: Snapshot =
    options.snapshot === undefined
      ? { enabled: true, provider: 'deepseek', model: 'deepseek-chat' }
      : options.snapshot
  let probeCalls = 0

  const probe = options.probe ?? (async () => ({ ok: true }))
  const deps: ChatStatusDeps = {
    registerChannel: (_channel, fn) => {
      listener = fn
    },
    getChatSnapshot: () => snapshot,
    probeChat: () => {
      probeCalls += 1
      return probe()
    },
    now: options.now ?? (() => 0),
    log: () => undefined
  }
  registerChatStatus(deps)

  return {
    status: () => listener({}, {}),
    setSnapshot: (value: Snapshot) => {
      snapshot = value
    },
    get probeCalls() {
      return probeCalls
    }
  }
}

describe('chat:status', () => {
  it('能力关闭时短路 disabled，不探活', () => {
    const harness = createHarness({ snapshot: { enabled: false, provider: 'deepseek' } })
    const value = harness.status()

    expect(value).toMatchObject({ state: 'disabled', stale: false, reason: 'chat.state.disabled' })
    shortCircuit.toHoldFor('pet:chat:status', () => harness.probeCalls)
  })

  it('没有可用上下文时短路 no-context，不探活', () => {
    const missing = createHarness({ snapshot: null })
    expect(missing.status()).toMatchObject({ state: 'no-context', stale: false, reason: 'chat.state.no-context' })
    shortCircuit.toHoldFor('pet:chat:status', () => missing.probeCalls)

    const unsupported = createHarness({ snapshot: { enabled: true, provider: 'custom' } })
    expect(unsupported.status()).toMatchObject({ state: 'no-context', stale: false })
    shortCircuit.toHoldFor('pet:chat:status', () => unsupported.probeCalls)
  })

  it('TTL 命中时短路，不重复探活', async () => {
    let now = 0
    const harness = createHarness({ now: () => now })

    expect(harness.status()).toMatchObject({ state: 'unknown', stale: true })
    await tick()

    const beforeTtlHit = harness.probeCalls
    expect(harness.status()).toMatchObject({ state: 'ready', stale: false, reason: 'chat.state.ready' })
    shortCircuit.toHoldFor('pet:chat:status', () => harness.probeCalls - beforeTtlHit)
    expect(harness.probeCalls).toBe(1)

    now += CHAT_STATUS_TTL_MS + 1
    expect(harness.status()).toMatchObject({ state: 'ready', stale: true })
    expect(harness.probeCalls).toBe(2)
  })

  it('stale 分支只触发一次探活，旧值允许过期返回', () => {
    const probeControl: { resolve: ((value: Record<string, unknown>) => void) | null } = { resolve: null }
    const harness = createHarness({
      probe: () =>
        new Promise((resolve) => {
          probeControl.resolve = resolve
        })
    })

    const first = harness.status()
    const second = harness.status()

    expect(first).toMatchObject({ state: 'unknown', stale: true, reason: 'chat.state.unknown' })
    expect(second).toMatchObject({ state: 'unknown', stale: true })
    expect(harness.probeCalls).toBe(1)

    probeControl.resolve?.({ ok: true })
  })

  it('探活失败回写 stale，不复用 voice 的 offline', async () => {
    const harness = createHarness({ probe: async () => ({ ok: false, reason: 'timeout' }) })

    harness.status()
    await tick()

    expect(harness.status()).toMatchObject({
      state: 'stale',
      stale: true,
      reason: 'chat.state.stale'
    })
  })

  it('快照始终带 state 与 stale，并保留本地上下文', () => {
    const harness = createHarness({
      snapshot: {
        enabled: true,
        provider: 'deepseek',
        model: 'deepseek-chat',
        historyCount: 3,
        busy: true
      }
    })

    expect(harness.status()).toMatchObject({
      ok: true,
      state: 'unknown',
      stale: true,
      reason: 'chat.state.unknown',
      provider: 'deepseek',
      model: 'deepseek-chat',
      historyCount: 3,
      busy: true
    })
  })

  it('源码里只有码，没有界面文案', () => {
    const source = readFileSync(new URL('../ipc/queries/chat-status.ts', import.meta.url), 'utf8')
    expect(source).not.toMatch(/['"`][^'"`\n]*[\u4e00-\u9fa5][^'"`\n]*['"`]/)
  })
})
