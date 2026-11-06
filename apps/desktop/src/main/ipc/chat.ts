import { writeExportFile } from './lib/exportFile.js'

type AnyRecord = Record<string, any>

/**
 * 聊天通道：send / clear / open / export。
 *
 * 通道层只做透传与编排，不碰文件格式、不发事件、不更新索引。
 * 落盘由 `chatService` 内部通过注入的 `persistTurn` / `persistClear` 完成。
 * clear 的返回态统一成 `{ ok, reason? }`：失败时 reason 一定是非空字符串，
 * 不把 undefined 丢给渲染层去兜底成「出了点状况（undefined）」。
 *
 * open 保持老语义：只负责开窗并返回 true，没有会话 id，也没有「找不到会话」的错误分支。
 * export 保持老语义：空历史返回 CHAT_EMPTY；取消返回 canceled；成功回绝对路径与条数。
 *
 * 已知取舍（既有行为，迁移时未改动）：user / assistant 两条 turn 分别落盘，
 * 第二条失败会留下「有问无答」的半条记录。要修成事务式写入需要改 chat.mjs
 * 的持久化契约，不在本次迁移范围内。
 */
export type ChatClearResult = { ok: boolean; reason?: string }
type ChatClearRaw = ChatClearResult | boolean

export interface ChatTurn {
  role: string
  content: string
}

export interface ChatChannelDeps {
  registerChannel: (channel: string, listener: (...args: any[]) => unknown) => void
  getChatService: () => {
    send: (payload: AnyRecord) => Promise<unknown>
    clear: () => ChatClearRaw | Promise<ChatClearRaw>
    history: () => ChatTurn[]
  }
  openChatWindow: () => void
  /**
   * 这句话在要照片时先真拍一张。
   * 返回 null 表示不是要照片；返回结果里只有渲染层能直接用的地址，没有图像字节。
   */
  takePhotoIfAsked?: (
    text: string
  ) => Promise<
    { ok: boolean; reason?: string; photo?: { url: string; path: string; at: string } } | null
  >
  showSaveDialog: (options: AnyRecord) => Promise<{ canceled: boolean; filePath?: string }>
  getDocumentsPath: () => string
  pathJoin: (...parts: string[]) => string
  fs: {
    writeFile: (file: string, data: string, encoding?: string) => Promise<void>
    restrictPermissions: (file: string) => Promise<void>
  }
  log: (...args: any[]) => void
}

/** 旧契约返回布尔，迁移期在通道层归一化；新契约直接返回对象。 */
function normalizeClearResult(result: ChatClearRaw | null | undefined): ChatClearResult {
  if (result === true) return { ok: true }
  if (result !== null && typeof result === 'object') {
    if (result.ok === true) return { ok: true }
    return { ok: false, reason: String(result.reason ?? 'persist-failed') }
  }
  return { ok: false, reason: 'persist-failed' }
}

export function registerChatChannels(deps: ChatChannelDeps): void {
  // 保持行首 register('…') 形式，契约门禁按这个口径扫描注册面。
  const register = deps.registerChannel

  register('pet:chat:send', async (_event, payload) => {
    // 与迁移前一致：payload 缺失时补空对象，交给 chatService 判空。
    const input = (payload ?? {}) as AnyRecord
    const said = typeof input.text === 'string' ? input.text : ''
    // 先拍再回：她嘴里的「拍好了」要配得上一张真的照片。
    // 没拍成也不拦这句话，只是把失败原因捎回界面，由界面自己说清楚。
    const shot =
      typeof deps.takePhotoIfAsked === 'function' ? await deps.takePhotoIfAsked(said) : null

    const result = (await deps.getChatService().send(input)) as AnyRecord | null | undefined
    if (shot === null || shot === undefined) return result

    const base =
      result !== null && typeof result === 'object' ? result : { ok: false, reason: 'request-failed' }
    if (base.ok !== true) return base
    if (shot.ok === true && shot.photo !== undefined) return { ...base, photo: shot.photo }
    return { ...base, photoFailed: String(shot.reason ?? 'capture-failed') }
  })

  register('pet:chat:clear', async () => {
    return normalizeClearResult(await deps.getChatService().clear())
  })

  /** 导出聊天记录：只在用户主动点击时写文件，内容不改动。 */
  register('pet:chat:export', async () => {
    const turns = deps.getChatService().history()
    if (turns.length === 0) return { ok: false, code: 'CHAT_EMPTY' }

    const stamp = new Date().toISOString().slice(0, 10)
    const { canceled, filePath } = await deps.showSaveDialog({
      title: '导出聊天记录',
      defaultPath: deps.pathJoin(deps.getDocumentsPath(), `昔涟聊天记录-${stamp}.md`),
      filters: [{ name: 'Markdown', extensions: ['md'] }]
    })
    if (canceled || typeof filePath !== 'string' || filePath === '') {
      return { ok: false, canceled: true }
    }

    const lines = [
      '# 昔涟 · 聊天记录',
      '',
      `导出时间：${new Date().toLocaleString('zh-CN')}`,
      `共 ${turns.length} 条`,
      ''
    ]
    for (const turn of turns) {
      const who = turn.role === 'user' ? '我' : '昔涟'
      lines.push(`## ${who}`, '', String(turn.content ?? ''), '')
    }

    try {
      await writeExportFile(deps.fs, filePath, lines.join('\n'), 'utf8')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      deps.log('[chat] 导出失败：', message)
      return { ok: false, code: 'WRITE_FAILED', message }
    }
    return { ok: true, path: filePath, count: turns.length }
  })

  register('pet:chat:open', () => {
    deps.openChatWindow()
    return true
  })
}
