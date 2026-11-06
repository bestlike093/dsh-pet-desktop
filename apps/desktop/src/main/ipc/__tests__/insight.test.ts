import { describe, expect, it, vi } from 'vitest'
import { registerInsightChannels } from '../insight.js'

type Handler = (event: unknown, payload?: unknown) => unknown

function harness(
  overrides: {
    snapshot?: () => Promise<Record<string, unknown>>
    remove?: (id: string) => Record<string, unknown>
    setFavor?: (value: number, options?: Record<string, unknown>) => Record<string, unknown>
  } = {}
) {
  const handlers = new Map<string, Handler>()
  const openWindow = vi.fn()
  const invalidate = vi.fn()
  const snapshot = vi.fn(overrides.snapshot ?? (async () => ({ sessions: [], memory: null })))
  const setFavor = vi.fn(overrides.setFavor ?? ((value: number) => ({ favor: value })))
  const adjustFavor = vi.fn((delta: number) => ({ favor: delta }))
  const setLocked = vi.fn((locked: boolean) => ({ locked }))
  const remove = vi.fn(overrides.remove ?? ((id: string) => ({ ok: true, removed: true, total: 4 })))

  registerInsightChannels({
    registerChannel: (name, handler) => handlers.set(name, handler as Handler),
    openWindow,
    insight: { snapshot, invalidate },
    affinity: { snapshot: vi.fn(), setFavor, adjustFavor, setLocked },
    memory: { remove },
    log: vi.fn()
  })

  return { handlers, openWindow, invalidate, snapshot, setFavor, adjustFavor, setLocked, remove }
}

describe('观察台通道', () => {
  it('打开窗口只调用一次入口', async () => {
    const { handlers, openWindow } = harness()
    expect(await handlers.get('pet:insight:open')!(null)).toEqual({ ok: true })
    expect(openWindow).toHaveBeenCalledTimes(1)
  })

  it('可以从设置页直接落到记忆分区', async () => {
    const { handlers, openWindow } = harness()
    await handlers.get('pet:insight:open')!(null, { tab: 'memory' })
    expect(openWindow).toHaveBeenLastCalledWith('memory')
  })

  it('四个分区都能直接落位', async () => {
    const { handlers, openWindow } = harness()
    for (const tab of ['today', 'mind', 'bonds', 'memory']) {
      await handlers.get('pet:insight:open')!(null, { tab })
      expect(openWindow).toHaveBeenLastCalledWith(tab)
    }
  })

  it('未知分区回落到默认页', async () => {
    const { handlers, openWindow } = harness()
    await handlers.get('pet:insight:open')!(null, { tab: 'settings' })
    expect(openWindow).toHaveBeenLastCalledWith(undefined)
  })

  it('分区不是字符串时按默认页打开', async () => {
    const { handlers, openWindow } = harness()
    await handlers.get('pet:insight:open')!(null, { tab: 3 })
    expect(openWindow).toHaveBeenLastCalledWith(undefined)
    await handlers.get('pet:insight:open')!(null, null)
    expect(openWindow).toHaveBeenLastCalledWith(undefined)
  })

  it('快照默认走缓存，force 才跳过', async () => {
    const { handlers, snapshot } = harness()
    await handlers.get('pet:insight:snapshot')!(null, {})
    expect(snapshot).toHaveBeenLastCalledWith({ force: false })
    await handlers.get('pet:insight:snapshot')!(null, { force: true })
    expect(snapshot).toHaveBeenLastCalledWith({ force: true })
  })

  it('快照失败给稳定错误码', async () => {
    const { handlers } = harness({
      snapshot: async () => {
        throw new Error('memory boom')
      }
    })
    const result = (await handlers.get('pet:insight:snapshot')!(null, {})) as Record<string, unknown>
    expect(result).toMatchObject({ ok: false, code: 'SNAPSHOT_FAILED' })
  })

  it('设定好感要求 scope 与数字，成功后让缓存失效', async () => {
    const { handlers, setFavor, invalidate } = harness()
    expect(await handlers.get('pet:insight:set-favor')!(null, { scope: 42, value: 10 })).toEqual({
      ok: false,
      code: 'INVALID_SCOPE'
    })
    expect(await handlers.get('pet:insight:set-favor')!(null, { scope: 'desktop' })).toEqual({
      ok: false,
      code: 'INVALID_VALUE'
    })
    expect(
      await handlers.get('pet:insight:set-favor')!(null, { scope: 'qq:group:g1', value: 72 })
    ).toMatchObject({ ok: true, scope: 'qq:group:g1', state: { favor: 72 } })
    expect(setFavor).toHaveBeenCalledWith(72, { scope: 'qq:group:g1', note: '手动设定' })
    expect(invalidate).toHaveBeenCalled()
  })

  it('空 scope 回落到桌面', async () => {
    const { handlers, setFavor } = harness()
    await handlers.get('pet:insight:set-favor')!(null, { scope: '  ', value: 5 })
    expect(setFavor).toHaveBeenCalledWith(5, { scope: 'desktop', note: '手动设定' })
  })

  it('加减好感挡住零与非法值', async () => {
    const { handlers, adjustFavor } = harness()
    expect(await handlers.get('pet:insight:adjust-favor')!(null, { delta: 0 })).toEqual({
      ok: false,
      code: 'NO_CHANGE'
    })
    expect(await handlers.get('pet:insight:adjust-favor')!(null, { delta: '3' })).toEqual({
      ok: false,
      code: 'INVALID_DELTA'
    })
    await handlers.get('pet:insight:adjust-favor')!(null, { scope: 'desktop', delta: -4 })
    expect(adjustFavor).toHaveBeenCalledWith(-4, { scope: 'desktop', note: '手动调整' })
  })

  it('锁定只接受布尔值', async () => {
    const { handlers, setLocked } = harness()
    expect(await handlers.get('pet:insight:lock-favor')!(null, { locked: 'yes' })).toEqual({
      ok: false,
      code: 'INVALID_LOCKED'
    })
    await handlers.get('pet:insight:lock-favor')!(null, { scope: 'desktop', locked: true })
    expect(setLocked).toHaveBeenCalledWith(true, { scope: 'desktop' })
  })

  it('重置先解锁再归零，只动这一份', async () => {
    const { handlers, setLocked, setFavor } = harness()
    expect(
      await handlers.get('pet:insight:reset-scope')!(null, { scope: 'qq:group:g1' })
    ).toMatchObject({ ok: true, scope: 'qq:group:g1' })
    expect(setLocked).toHaveBeenCalledWith(false, { scope: 'qq:group:g1' })
    expect(setFavor).toHaveBeenCalledWith(0, { scope: 'qq:group:g1', note: '重置这段关系' })
    expect(setLocked.mock.invocationCallOrder[0] ?? 0).toBeLessThan(
      setFavor.mock.invocationCallOrder[0] ?? 0
    )
  })

  it('删记忆要 id，并把存储结果原样带上', async () => {
    const { handlers, remove } = harness({
      remove: (id) => ({ ok: false, reason: 'not-found', removed: false, total: 4 })
    })
    expect(await handlers.get('pet:insight:delete-memory')!(null, { id: '   ' })).toEqual({
      ok: false,
      code: 'INVALID_ID'
    })
    expect(remove).not.toHaveBeenCalled()
    expect(await handlers.get('pet:insight:delete-memory')!(null, { id: 'm9' })).toEqual({
      ok: false,
      removed: false,
      reason: 'not-found',
      total: 4
    })
    expect(remove).toHaveBeenCalledWith('m9')
  })

  it('存储抛错不把异常丢给界面', async () => {
    const { handlers } = harness({
      remove: () => {
        throw new Error('disk gone')
      }
    })
    const result = (await handlers.get('pet:insight:delete-memory')!(null, {
      id: 'm1'
    })) as Record<string, unknown>
    expect(result).toMatchObject({ ok: false, code: 'DELETE_FAILED' })
  })
})
