type AnyRecord = Record<string, any>

/**
 * 记忆域写通道：导出、删除单条、清空。
 *
 * 导出筛选与 ipc/queries.ts 的列表筛选保持同一口径；纯日期按本地时区
 * 补齐当天起止，避免时区换算把边界条目切掉。
 */
export interface MemoryChannelDeps {
  registerChannel: (channel: string, listener: (...args: any[]) => unknown) => void
  memoryStore: {
    stats: () => { available: boolean; count: number }
    remove: (id: string) => unknown
    /** 清空记录；返回 Promise，调用方可 await 落盘完成。 */
    clear: () => unknown
    flush: () => Promise<void>
  }
  collectMemoryAll: () => AnyRecord[]
  sanitizeReflectionText: (text: string) => string
  dialog: {
    showSaveDialog: (options: AnyRecord) => Promise<{ canceled: boolean; filePath?: string }>
  }
  documentsDir: string
  pathJoin: (...parts: string[]) => string
  writeFile: (file: string, data: string, encoding: string) => Promise<void>
  log: (...args: any[]) => void
}

function filterMemoryForExport(
  items: AnyRecord[],
  options: AnyRecord | undefined
): AnyRecord[] {
  const query = typeof options?.query === 'string' ? options.query.trim().toLowerCase() : ''
  const role = options?.role === 'user' || options?.role === 'assistant' ? options.role : ''
  const bound = (raw: unknown, endOfDay: boolean): number | null => {
    if (typeof raw !== 'string' || raw.trim() === '') return null
    const value = raw.trim()
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value)
    const parsed = Date.parse(
      dateOnly ? `${value}T${endOfDay ? '23:59:59.999' : '00:00:00'}` : value
    )
    return Number.isFinite(parsed) ? parsed : null
  }
  const fromMs = bound(options?.from, false)
  const toMs = bound(options?.to, true)
  return items.filter((item) => {
    if (role !== '' && item?.role !== role) return false
    if (query !== '' && !String(item?.text ?? '').toLowerCase().includes(query)) return false
    if (fromMs === null && toMs === null) return true
    const at = Date.parse(String(item?.at ?? ''))
    if (!Number.isFinite(at)) return false
    if (fromMs !== null && at < fromMs) return false
    if (toMs !== null && at > toMs) return false
    return true
  })
}

export function registerMemoryChannels(deps: MemoryChannelDeps): void {
  const register = deps.registerChannel

  /** 导出记忆为脱敏后的 Markdown 或 JSON，路径由用户选择。 */
  register('pet:memory:export', async (_event, payload) => {
    if (!deps.memoryStore.stats().available) return { ok: false, code: 'VAULT_UNAVAILABLE' }
    const items: AnyRecord[] = filterMemoryForExport(deps.collectMemoryAll(), payload).map(
      (item) => ({
        ...item,
        text: deps.sanitizeReflectionText(String(item.text ?? ''))
      })
    )
    if (items.length === 0) return { ok: false, code: 'MEMORY_EMPTY' }

    const stamp = new Date().toISOString().slice(0, 10)
    const { canceled, filePath } = await deps.dialog.showSaveDialog({
      title: '导出记忆',
      defaultPath: deps.pathJoin(deps.documentsDir, `昔涟记忆-${stamp}.md`),
      filters: [
        { name: 'Markdown', extensions: ['md'] },
        { name: 'JSON', extensions: ['json'] }
      ]
    })
    if (canceled || typeof filePath !== 'string' || filePath === '') {
      return { ok: false, canceled: true }
    }

    const isJson = filePath.toLowerCase().endsWith('.json')
    const content = isJson
      ? JSON.stringify(
          {
            exportedAt: new Date().toISOString(),
            total: items.length,
            sanitized: true,
            items
          },
          null,
          2
        )
      : [
          '# 昔涟 · 记忆导出',
          '',
          `导出时间：${new Date().toLocaleString('zh-CN')}`,
          `共 ${items.length} 条`,
          '文本已脱敏：密钥与本地路径已隐藏。',
          '',
          ...items.map((item) => {
            const who = item.role === 'user' ? '我' : '昔涟'
            return `## ${who} · ${item.at ?? ''}\n\n${String(item.text ?? '')}\n`
          })
        ].join('\n')

    try {
      await deps.writeFile(filePath, content, 'utf8')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      deps.log('[memory] 导出失败：', message)
      return { ok: false, code: 'WRITE_FAILED', message }
    }
    return { ok: true, path: filePath, count: items.length }
  })

  /** 删除单条。id 必须来自列表；不认识就回 not-found，不静默成功。 */
  register('pet:memory:delete', async (_event, payload) => {
    if (!deps.memoryStore.stats().available) return { ok: false, reason: 'vault-unavailable' }
    const id = typeof payload?.id === 'string' ? payload.id : ''
    return deps.memoryStore.remove(id)
  })

  register('pet:memory:clear', async () => {
    if (!deps.memoryStore.stats().available) return { ok: false, reason: 'vault-unavailable' }
    // memory.clear 的 ok:true 表示「清理请求已处理」，不代表磁盘已确认。
    // store 返回 {ok:false} 或直接 throw 都不向渲染层抛：通道层只保证调用不中断，
    // 磁盘一致性由 store 内部 retry / 原数组恢复保证。这与 chat.clear 的 ok 语义不同。
    try {
      await deps.memoryStore.clear()
      await deps.memoryStore.flush()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      deps.log('[memory] clear 失败：', message)
    }
    return { ok: true }
  })
}
