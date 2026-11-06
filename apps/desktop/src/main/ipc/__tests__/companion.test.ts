import { describe, expect, it, vi } from 'vitest'
import { registerCompanionAgendaChannels } from '../companion.js'

type Handler = (event: unknown, payload?: unknown) => unknown

function harness(
  overrides: {
    note?: () => Promise<string>
    reschedule?: (minutes: number) => Promise<Record<string, unknown>>
    enabled?: boolean
  } = {}
) {
  const handlers = new Map<string, Handler>()
  const agendaNote = vi.fn(overrides.note ?? (async () => '现在做正事。接下来是：留白（12:00 开始）。'))
  const interruptAgenda = vi.fn(
    overrides.reschedule ?? (async () => ({ changed: true, reason: undefined }))
  )

  registerCompanionAgendaChannels({
    registerChannel: (name, handler) => handlers.set(name, handler as Handler),
    companionService: {
      enabled: () => overrides.enabled ?? true,
      agendaNote,
      interruptAgenda
    },
    log: vi.fn()
  })

  return { handlers, agendaNote, interruptAgenda }
}

describe('陪伴日程通道', () => {
  it('读通道回当前与接下来的安排', async () => {
    const { handlers } = harness()
    await expect(handlers.get('pet:companion:agenda')!(null)).resolves.toEqual({
      ok: true,
      enabled: true,
      note: '现在做正事。接下来是：留白（12:00 开始）。'
    })
  })

  it('读失败不抛出去，给稳定错误码', async () => {
    const { handlers } = harness({
      note: async () => {
        throw new Error('vault locked')
      }
    })
    const result = (await handlers.get('pet:companion:agenda')!(null)) as Record<string, unknown>
    expect(result.ok).toBe(false)
    expect(result.code).toBe('READ_FAILED')
  })

  it('顺延分钟数必须是正数且不超过四小时', async () => {
    const { handlers, interruptAgenda } = harness()
    for (const minutes of [0, -5, 241, Number.NaN]) {
      const result = (await handlers.get('pet:companion:agenda:reschedule')!(null, {
        minutes
      })) as Record<string, unknown>
      expect(result).toEqual({ ok: false, code: 'INVALID_MINUTES' })
    }
    expect(interruptAgenda).not.toHaveBeenCalled()
  })

  it('顺延后回传是否改动与原因，并刷新概要', async () => {
    const { handlers, interruptAgenda, agendaNote } = harness({
      reschedule: async () => ({ changed: false, reason: 'sleeping' })
    })
    await expect(
      handlers.get('pet:companion:agenda:reschedule')!(null, { minutes: 30 })
    ).resolves.toEqual({
      ok: true,
      changed: false,
      reason: 'sleeping',
      note: '现在做正事。接下来是：留白（12:00 开始）。'
    })
    expect(interruptAgenda).toHaveBeenCalledWith(30)
    expect(agendaNote).toHaveBeenCalledTimes(1)
  })

  it('主进程抛错时给 RESCHEDULE_FAILED', async () => {
    const { handlers } = harness({
      reschedule: async () => {
        throw new Error('save failed')
      }
    })
    const result = (await handlers.get('pet:companion:agenda:reschedule')!(null, {
      minutes: 30
    })) as Record<string, unknown>
    expect(result.ok).toBe(false)
    expect(result.code).toBe('RESCHEDULE_FAILED')
  })
})
