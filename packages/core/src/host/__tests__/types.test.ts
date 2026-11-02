import { describe, expect, it } from 'vitest'
import {
  RuntimeCapabilityError,
  requireCapability,
  runtimeOps
} from '../types.js'
import type { PetRuntime, PetMessage, RuntimeCapabilities } from '../types.js'

const FULL: RuntimeCapabilities = {
  session: true,
  notify: true,
  speech: true,
  capture: true,
  input: true,
  storage: true
}

const MINIMAL: RuntimeCapabilities = {
  session: true,
  notify: true,
  speech: false,
  capture: false,
  input: false,
  storage: true
}

function fakeRuntime(capabilities: RuntimeCapabilities = FULL): PetRuntime & {
  spoken: string[]
  notices: string[]
  store: Map<string, unknown>
} {
  const spoken: string[] = []
  const notices: string[] = []
  const store = new Map<string, unknown>()

  return {
    id: 'standalone',
    capabilities,
    spoken,
    notices,
    store,
    now: () => 1_700_000_000_000,
    async openSession() {
      return { id: 's-1' }
    },
    async appendMessage(_session, _message: PetMessage) {},
    async notify(notice) {
      notices.push(notice.title)
    },
    async speak(text) {
      spoken.push(text)
    },
    async capture() {
      return { width: 1, height: 1, data: new Uint8Array(4), at: 0 }
    },
    async click() {},
    async readState<T>(key: string) {
      return (store.get(key) as T | undefined) ?? null
    },
    async writeState<T>(key: string, value: T) {
      store.set(key, value)
    }
  }
}

describe('requireCapability', () => {
  it('有该能力时通过', () => {
    expect(() => requireCapability(fakeRuntime(), 'speech')).not.toThrow()
  })

  it('缺能力时抛 RuntimeCapabilityError 并带上能力名', () => {
    const runtime = fakeRuntime(MINIMAL)
    expect(() => requireCapability(runtime, 'capture')).toThrow(RuntimeCapabilityError)
    try {
      requireCapability(runtime, 'capture')
    } catch (error) {
      expect((error as RuntimeCapabilityError).capability).toBe('capture')
      expect((error as RuntimeCapabilityError).message).toContain('standalone')
    }
  })
})

describe('runtimeOps', () => {
  it('有语音就说话，返回 true', async () => {
    const runtime = fakeRuntime()
    expect(await runtimeOps.trySpeak(runtime, '晚上好')).toBe(true)
    expect(runtime.spoken).toEqual(['晚上好'])
  })

  it('没语音时静默跳过，返回 false 而不是抛错', async () => {
    const runtime = fakeRuntime(MINIMAL)
    expect(await runtimeOps.trySpeak(runtime, '晚上好')).toBe(false)
    expect(runtime.spoken).toEqual([])
  })

  it('没通知能力时不假装发出', async () => {
    const runtime = fakeRuntime({ ...MINIMAL, notify: false })
    expect(await runtimeOps.tryNotify(runtime, { title: 't', body: 'b' })).toBe(false)
    expect(runtime.notices).toEqual([])
  })

  it('没存储时读状态返回 null', async () => {
    const runtime = fakeRuntime({ ...MINIMAL, storage: false })
    expect(await runtimeOps.readStateOrNull(runtime, 'k')).toBeNull()
  })

  it('有存储时能写能读', async () => {
    const runtime = fakeRuntime()
    await runtime.writeState('k', { a: 1 })
    expect(await runtimeOps.readStateOrNull<{ a: number }>(runtime, 'k')).toEqual({ a: 1 })
  })

  it('没抓帧能力时返回 null', async () => {
    const runtime = fakeRuntime(MINIMAL)
    expect(await runtimeOps.captureOrNull(runtime)).toBeNull()
  })

  it('capabilities 说能抓但方法没实现时返回 null', async () => {
    const runtime = fakeRuntime()
    const broken = { ...runtime, capture: undefined }
    expect(await runtimeOps.captureOrNull(broken)).toBeNull()
  })
})
