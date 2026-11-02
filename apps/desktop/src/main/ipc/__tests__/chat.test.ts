import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerChatChannels, type ChatChannelDeps } from '../chat.js'

type Handler = (event: unknown, payload?: unknown) => Promise<unknown>
type ChatTurn = { role: string; content: string }

interface HarnessOverrides {
  send?: ReturnType<typeof vi.fn>
  clear?: ReturnType<typeof vi.fn>
  history?: ReturnType<typeof vi.fn>
  showSaveDialog?: ReturnType<typeof vi.fn>
  writeFile?: ReturnType<typeof vi.fn>
}

function harness(overrides: HarnessOverrides = {}) {
  const sendMock = overrides.send ?? vi.fn(async () => ({ ok: true, reply: '嗯' }))
  const clearMock = overrides.clear ?? vi.fn(async () => ({ ok: true }))
  const historyMock = overrides.history ?? vi.fn(() => [] as ChatTurn[])
  const openChatWindow = vi.fn()
  const showSaveDialog =
    overrides.showSaveDialog ?? vi.fn(async () => ({ canceled: true as const }))
  const writeFile =
    overrides.writeFile ?? vi.fn(async (_file: string, _data: string, _encoding?: string) => undefined)
  const restrictPermissions = vi.fn(async (_file: string) => undefined)
  const log = vi.fn()
  const handlers = new Map<string, Handler>()
  const getChatService = vi.fn(
    (): ReturnType<ChatChannelDeps['getChatService']> => ({
      send: sendMock as (payload: Record<string, any>) => Promise<unknown>,
      clear: clearMock as () => { ok: boolean; reason?: string } | boolean,
      history: historyMock as () => ChatTurn[]
    })
  )

  registerChatChannels({
    registerChannel: (name, handler) => handlers.set(name, handler as Handler),
    getChatService,
    openChatWindow,
    showSaveDialog: showSaveDialog as (
      options: Record<string, any>
    ) => Promise<{ canceled: boolean; filePath?: string }>,
    getDocumentsPath: () => 'C:/docs',
    pathJoin: (...parts: string[]) => parts.join('/'),
    fs: {
      writeFile: writeFile as (
        file: string,
        data: string,
        encoding?: string
      ) => Promise<void>,
      restrictPermissions: restrictPermissions as (file: string) => Promise<void>
    },
    log
  })

  return {
    handlers,
    send: sendMock,
    clear: clearMock,
    history: historyMock,
    getChatService,
    openChatWindow,
    showSaveDialog,
    writeFile,
    restrictPermissions,
    log
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('聊天通道', () => {
  it('send 把 payload 原样交给 chatService', async () => {
    const { handlers, send } = harness()
    const payload = { text: '今天有点累' }

    await handlers.get('pet:chat:send')!(null, payload)

    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith(payload)
  })

  it('payload 缺失时补空对象', async () => {
    const { handlers, send } = harness()

    await handlers.get('pet:chat:send')!(null, undefined)

    expect(send).toHaveBeenCalledWith({})
  })

  it('返回值原样返回，不二次包装', async () => {
    const response = { ok: false, reason: 'empty' }
    const { handlers } = harness({ send: vi.fn(async () => response) })

    await expect(handlers.get('pet:chat:send')!(null, {})).resolves.toBe(response)
  })

  it('通道层不额外调用 chatService，也不吞错', async () => {
    const send = vi.fn(async () => {
      throw new Error('network-down')
    })
    const { handlers, getChatService } = harness({ send })

    await expect(handlers.get('pet:chat:send')!(null, { text: 'hi' })).rejects.toThrow(
      'network-down'
    )
    expect(getChatService).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('clear 调用 chatService 一次，并把失败返回态透传', async () => {
    const response = { ok: false, reason: 'persist-failed' }
    const { handlers, clear } = harness({ clear: vi.fn(async () => response) })

    await expect(handlers.get('pet:chat:clear')!(null)).resolves.toEqual(response)
    expect(clear).toHaveBeenCalledTimes(1)
  })

  it('旧布尔契约 true 归一化为 { ok: true }', async () => {
    const { handlers } = harness({ clear: vi.fn(() => true) })

    await expect(handlers.get('pet:chat:clear')!(null)).resolves.toEqual({ ok: true })
  })

  it('失败返回态缺 reason 时补 persist-failed，不把 undefined 交给渲染层', async () => {
    const { handlers } = harness({ clear: vi.fn(async () => ({ ok: false })) })

    await expect(handlers.get('pet:chat:clear')!(null)).resolves.toEqual({
      ok: false,
      reason: 'persist-failed'
    })
  })

  it('open 只开窗并返回 true，空历史也不报错', () => {
    const { handlers, openChatWindow } = harness()

    const result = handlers.get('pet:chat:open')!(null)

    // open 老语义没有会话 id，也不读 history；空历史下仍是成功。
    expect(result).toBe(true)
    expect(openChatWindow).toHaveBeenCalledTimes(1)
  })

  it('export 空历史返回 CHAT_EMPTY，不弹保存框', async () => {
    const { handlers, showSaveDialog } = harness()

    await expect(handlers.get('pet:chat:export')!(null)).resolves.toEqual({
      ok: false,
      code: 'CHAT_EMPTY'
    })
    expect(showSaveDialog).not.toHaveBeenCalled()
  })

  it('export 取消时返回 canceled，不写文件、不限权', async () => {
    const { handlers, showSaveDialog, writeFile, restrictPermissions } = harness({
      history: vi.fn(() => [{ role: 'user', content: 'x' }])
    })
    const result = await handlers.get('pet:chat:export')!(null)

    expect(result).toEqual({ ok: false, canceled: true })
    expect(showSaveDialog).toHaveBeenCalledTimes(1)
    expect(writeFile).not.toHaveBeenCalled()
    expect(restrictPermissions).not.toHaveBeenCalled()
  })

  it('export 写入内容严格等于生成的 Markdown，成功后才限权', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-02T08:00:00.000Z'))
    const history = vi.fn(() => [
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '在的' }
    ])
    const showSaveDialog = vi.fn(async () => ({
      canceled: false as const,
      filePath: 'C:/docs/chat.md'
    }))
    const { handlers, writeFile, restrictPermissions } = harness({ history, showSaveDialog })

    const result = await handlers.get('pet:chat:export')!(null)

    const expected = [
      '# 昔涟 · 聊天记录',
      '',
      `导出时间：${new Date().toLocaleString('zh-CN')}`,
      '共 2 条',
      '',
      '## 我',
      '',
      '你好',
      '',
      '## 昔涟',
      '',
      '在的',
      ''
    ].join('\n')
    expect(result).toEqual({ ok: true, path: 'C:/docs/chat.md', count: 2 })
    expect(writeFile).toHaveBeenCalledTimes(1)
    expect(writeFile).toHaveBeenCalledWith('C:/docs/chat.md', expected, 'utf8')
    expect(restrictPermissions).toHaveBeenCalledWith('C:/docs/chat.md')
  })

  it('export 写盘失败时返回 WRITE_FAILED，且不限权', async () => {
    const showSaveDialog = vi.fn(async () => ({
      canceled: false as const,
      filePath: 'C:/docs/chat.md'
    }))
    const writeFile = vi.fn(async (_file: string, _data: string, _encoding?: string) => {
      throw new Error('disk full')
    })
    const { handlers, restrictPermissions } = harness({
      history: vi.fn(() => [{ role: 'user', content: 'x' }]),
      showSaveDialog,
      writeFile
    })

    const result = await handlers.get('pet:chat:export')!(null)

    expect(result).toEqual({ ok: false, code: 'WRITE_FAILED', message: 'disk full' })
    expect(restrictPermissions).not.toHaveBeenCalled()
  })
})
