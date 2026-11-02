/**
 * 记忆存储：把聊过的内容加密落盘，再按需装配成提示词片段。
 *
 * 设计上的几条底线：
 * - 只用注入的 seal / open，不自己实现加密；封不上就不写盘，绝不退回明文
 * - 写入走临时文件 + rename，断电不会留下半截密文
 * - 文件损坏时改名留证据，再从空记忆开始，不静默覆盖
 * - 落盘防抖，连续对话不会每句都写一次磁盘
 */

const DEFAULT_MAX_ITEMS = 500
const SAVE_DEBOUNCE_MS = 500
const MAX_TEXT_CHARS = 2_000

function clampText(text) {
  const value = typeof text === 'string' ? text : ''
  return value.length > MAX_TEXT_CHARS ? value.slice(0, MAX_TEXT_CHARS) : value
}

/**
 * @param {object} options
 * @param {string} options.filePath 密文文件路径
 * @param {(value: object) => Promise<object>} [options.seal]
 * @param {(sealed: object) => Promise<Uint8Array>} [options.open]
 * @param {number} [options.maxItems]
 * @param {(...args: unknown[]) => void} [options.log]
 */
export function createMemoryStore(options) {
  const { filePath, seal, open, log, maxItems = DEFAULT_MAX_ITEMS, getMaxItems } = options
  const fallbackLimit = Number.isFinite(maxItems) && maxItems > 0 ? Math.floor(maxItems) : DEFAULT_MAX_ITEMS

  /** 上限跟着设置走：用户把条数改小，下一次写入就按新值裁。 */
  function currentLimit() {
    const value = typeof getMaxItems === 'function' ? Number(getMaxItems()) : fallbackLimit
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallbackLimit
  }

  /** @type {{ id: string, role: 'user'|'assistant', text: string, at: string }[]} */
  let records = []
  let updatedAt = null
  let loaded = false
  let saveTimer = null
  /** 有未落盘的变更。 */
  let dirty = false
  /** 写入串行链，flush 能等到队列里的最后一份。 */
  let writeChain = Promise.resolve(true)

  let available = typeof seal === 'function' && typeof open === 'function'

  /** 加密仓库装配失败时由上层调用：从此不写盘、不报告已持久化。 */
  function disable() {
    available = false
    records = []
    updatedAt = null
  }

  async function readSealed() {
    const { readFile } = await import('node:fs/promises')
    try {
      return JSON.parse(await readFile(filePath, 'utf8'))
    } catch (error) {
      if (error?.code === 'ENOENT') return null
      throw error
    }
  }

  /** 损坏文件改名保留证据；读不出来就当空记忆，不猜测内容。 */
  async function quarantine(error) {
    const fs = await import('node:fs/promises')
    const backup = `${filePath}.corrupt-${Date.now()}`
    try {
      await fs.rename(filePath, backup)
      log?.('记忆文件无法读取，已改名保留：', backup, String(error?.message ?? error))
    } catch (renameError) {
      log?.('记忆文件隔离失败：', String(renameError?.message ?? renameError))
    }
  }

  async function load() {
    if (!available) {
      loaded = true
      return { ok: false, reason: 'vault-unavailable' }
    }
    let sealed = null
    try {
      sealed = await readSealed()
    } catch (error) {
      await quarantine(error)
      loaded = true
      return { ok: false, reason: 'unreadable' }
    }
    if (sealed === null) {
      loaded = true
      return { ok: true, count: 0 }
    }

    try {
      const plain = await open(sealed)
      const parsed = JSON.parse(new TextDecoder().decode(plain))
      const list = Array.isArray(parsed?.records) ? parsed.records : []
      records = list
        .filter(
          (item) =>
            item !== null &&
            typeof item === 'object' &&
            typeof item.text === 'string' &&
            (item.role === 'user' || item.role === 'assistant')
        )
        .map((item) => ({
          id: String(item.id ?? ''),
          role: item.role,
          text: clampText(item.text),
          at: typeof item.at === 'string' ? item.at : ''
        }))
        .slice(-currentLimit())
      updatedAt = typeof parsed?.updatedAt === 'string' ? parsed.updatedAt : null
      loaded = true
      return { ok: true, count: records.length }
    } catch (error) {
      await quarantine(error)
      records = []
      updatedAt = null
      loaded = true
      return { ok: false, reason: 'undecryptable' }
    }
  }

  /**
   * 写入串行化：多次写入排成一条链，后一次一定看到前一次的结果。
   * 有未落盘变更（dirty）才真正写，避免空转。
   */
  function writeNow() {
    if (!available) return Promise.resolve(false)
    const task = writeChain.then(async () => {
      if (!dirty) return true
      const snapshot = { version: 1, updatedAt, records: [...records] }
      dirty = false
      try {
        const fs = await import('node:fs/promises')
        const sealed = await seal(snapshot)
        await fs.mkdir(filePath.replace(/[\\/][^\\/]+$/, ''), { recursive: true })
        const temp = `${filePath}.tmp`
        await fs.writeFile(temp, JSON.stringify(sealed), 'utf8')
        await fs.rename(temp, filePath)
        return true
      } catch (error) {
        log?.('记忆写入失败：', String(error?.message ?? error))
        dirty = true
        return false
      }
    })
    writeChain = task.catch(() => false)
    return task
  }

  function scheduleSave() {
    if (!available) return
    if (saveTimer !== null) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      saveTimer = null
      void writeNow()
    }, SAVE_DEBOUNCE_MS)
  }

  /**
   * 追加一轮对话。deviceId 之类的元信息不在这里存：
   * 记忆只需要「谁说的、说了什么、什么时候」。
   */
  function appendTurn(role, text, at = new Date().toISOString()) {
    if (!available) return false
    const value = clampText(text).trim()
    if (value === '') return false
    if (role !== 'user' && role !== 'assistant') return false

    records.push({
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      role,
      text: value,
      at
    })
    const limit = currentLimit()
    if (records.length > limit) records.splice(0, records.length - limit)
    updatedAt = at
    dirty = true
    scheduleSave()
    return true
  }

  function recent(count = 8) {
    const n = Number.isFinite(count) && count > 0 ? Math.floor(count) : 8
    return records.slice(-n).map((item) => ({ ...item }))
  }

  /**
   * 装配成提示词里的一段。没有记忆时返回空串，调用方据此不加这一段。
   */
  function digestText(count = 6) {
    const items = recent(count)
    if (items.length === 0) return ''
    const lines = items.map((item) => `${item.role === 'user' ? '用户' : '你'}：${item.text}`)
    return lines.join('\n')
  }

  /**
   * 分页读取，最新在前。offset / limit 都做上限保护：
   * 渲染侧传什么都不会一次把整份记忆抽走。
   */
  function list(options = {}) {
    const total = records.length
    const rawOffset = Number(options?.offset)
    const rawLimit = Number(options?.limit)
    const offset = Number.isFinite(rawOffset) ? Math.min(Math.max(Math.floor(rawOffset), 0), total) : 0
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.floor(rawLimit), 1), 200) : 50
    const ordered = records.slice().reverse()
    return {
      total,
      offset,
      limit,
      items: ordered.slice(offset, offset + limit).map((item) => ({ ...item }))
    }
  }

  /** 删除单条。删完立刻落盘，不留在防抖窗口里。 */
  function remove(id) {
    if (!available) return { ok: false, reason: 'vault-unavailable', removed: false, total: records.length }
    const key = typeof id === 'string' ? id.trim() : ''
    if (key === '') return { ok: false, reason: 'bad-id', removed: false, total: records.length }
    const index = records.findIndex((item) => item.id === key)
    if (index === -1) return { ok: false, reason: 'not-found', removed: false, total: records.length }

    const [removed] = records.splice(index, 1)
    updatedAt = new Date().toISOString()
    dirty = true
    void writeNow()
    return { ok: true, removed: true, total: records.length, item: { ...removed } }
  }

  /**
   * 清空记录：先把空快照落盘，成功后才清内存。
   * 失败时恢复原数组并把错误冒泡给调用方，避免「内存已空、磁盘还在」。
   * 并发调用复用同一个任务，只写一次盘。
   */
  let clearTask = null
  function clear() {
    if (clearTask !== null) return clearTask
    clearTask = (async () => {
      if (!available) return { ok: false, reason: 'vault-unavailable' }

      const savedRecords = records
      const savedUpdatedAt = updatedAt
      records = []
      updatedAt = new Date().toISOString()
      dirty = true

      const ok = await writeNow()
      if (!ok) {
        // 落盘失败：内存恢复原数组，dirty 由 writeNow 保持 true，下次可重试。
        records = savedRecords
        updatedAt = savedUpdatedAt
        return { ok: false, reason: 'persist-failed' }
      }
      return { ok: true }
    })().finally(() => {
      clearTask = null
    })
    return clearTask
  }

  function stats() {
    return {
      available,
      persisted: available && updatedAt !== null,
      count: records.length,
      limit: currentLimit(),
      updatedAt,
      loaded
    }
  }

  async function flush() {
    if (saveTimer !== null) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
    // 等队列清空；如果等完之后又产生新变更，再补写一次。
    await writeChain
    if (!dirty) return true
    return await writeNow()
  }

  return { load, appendTurn, recent, list, remove, digestText, clear, stats, flush, disable }
}
