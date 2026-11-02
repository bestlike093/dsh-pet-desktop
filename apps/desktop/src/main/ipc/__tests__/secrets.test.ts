import { describe, expect, it, vi } from 'vitest'
import { registerSecretChannels } from '../secrets.js'

type Handler = (event: unknown, request?: unknown) => Promise<Record<string, any>>

function harness(overrides: Record<string, any> = {}) {
  const handlers = new Map<string, Handler>()
  const store = {
    set: vi.fn(async () => undefined),
    clear: vi.fn(async () => undefined)
  }
  const deps = {
    registerChannel: (name: string, handler: Handler) => handlers.set(name, handler),
    requireSecretStore: () => store,
    ...overrides
  }

  registerSecretChannels(deps as any)
  return { handlers, store, deps }
}

describe('外部服务密钥写通道', () => {
  it('set 去掉首尾空白后落盘，默认字段由 store 决定', async () => {
    const { handlers, store } = harness()

    const result = await handlers.get('pet:secrets:set')!(null, {
      serviceId: 'weather',
      value: '  sk-test-123  '
    })

    expect(result).toEqual({ ok: true })
    expect(store.set).toHaveBeenCalledWith('weather', 'sk-test-123', undefined)
  })

  it('set 显式字段原样透传', async () => {
    const { handlers, store } = harness()

    await handlers.get('pet:secrets:set')!(null, {
      serviceId: 'weather',
      field: 'token',
      value: 'abc'
    })

    expect(store.set).toHaveBeenCalledWith('weather', 'abc', 'token')
  })

  it('set 空值直接拒绝，不触碰 store', async () => {
    const { handlers, store } = harness()

    await expect(
      handlers.get('pet:secrets:set')!(null, { serviceId: 'weather', value: '   ' })
    ).rejects.toThrow('密钥不能为空')
    expect(store.set).not.toHaveBeenCalled()
  })

  it('set 请求不是对象时拒绝', async () => {
    const { handlers, store } = harness()

    await expect(handlers.get('pet:secrets:set')!(null, 'weather')).rejects.toThrow(
      '请求必须是对象'
    )
    expect(store.set).not.toHaveBeenCalled()
  })

  it('clear 原样透传 serviceId 与 field', async () => {
    const { handlers, store } = harness()

    const result = await handlers.get('pet:secrets:clear')!(null, {
      serviceId: 'weather',
      field: 'token'
    })

    expect(result).toEqual({ ok: true })
    expect(store.clear).toHaveBeenCalledWith('weather', 'token')
  })

  it('clear 的 field 为空字符串时按默认字段处理', async () => {
    const { handlers, store } = harness()

    await handlers.get('pet:secrets:clear')!(null, { serviceId: 'weather', field: '' })

    expect(store.clear).toHaveBeenCalledWith('weather', undefined)
  })

  it('vault 未装配时保留原来的抛错行为，不吞成 ok:false', async () => {
    const { handlers } = harness({
      requireSecretStore: () => {
        throw new Error('VAULT_UNAVAILABLE：加密仓库没有装配成功，拒绝以明文替代')
      }
    })

    await expect(
      handlers.get('pet:secrets:set')!(null, { serviceId: 'weather', value: 'abc' })
    ).rejects.toThrow('VAULT_UNAVAILABLE')
  })
})
