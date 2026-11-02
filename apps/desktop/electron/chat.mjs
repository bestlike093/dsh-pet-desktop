/**
 * 聊天服务：把「设置 + 密钥 + 历史」拼成一次对话请求。
 *
 * 这里只管协议与状态，不碰窗口、不碰渲染层：
 * - 密钥由调用方从加密仓库取，本模块不写日志
 * - 端点写死在这里，渲染侧无法指定别的地址
 * - 历史落盘通过注入的 persistTurn / persistClear，本模块不碰文件系统
 * - 失败一律回结构化 reason，界面据此写清楚原因，不假装成功
 */

const CHAT_ENDPOINT = 'https://api.deepseek.com/chat/completions'
const CHAT_TIMEOUT_MS = 45_000

/** 单条消息长度上限：防止一次粘贴把上下文撑爆。 */
const MAX_MESSAGE_CHARS = 4_000

/** 从磁盘恢复时最多接回多少条，避免一次开机把旧历史全塞进内存。 */
const MAX_RESTORED_TURNS = 200

/** 目前唯一支持的服务商。自定义端点不开放，避免把 Key 发到任意地址。 */
const SUPPORTED_PROVIDER = 'deepseek'

/**
 * 拼 system 文本。人格由 persona 模块提供，记忆片段由存储层提供，
 * 这里只负责把它们按固定顺序接起来，不自己编人格内容。
 */
function composeSystemPrompt(personaText, memoryText) {
  const lines = [
    typeof personaText === 'string' && personaText.trim() !== ''
      ? personaText.trim()
      : '做一个简洁、友好的桌面对话伙伴。'
  ]
  if (typeof memoryText === 'string' && memoryText.trim() !== '') {
    lines.push('', '下面是你记得的早前对话。只在和当前话题相关时自然用上，不要逐条复述：')
    lines.push(memoryText.trim())
  }
  return lines.join('\n')
}

/** 历史裁剪：按轮保留，最近的在后面。role 只允许 user / assistant。 */
function trimTurns(turns, maxTurns) {
  const limit = Number.isFinite(maxTurns) && maxTurns > 0 ? Math.floor(maxTurns) : 10
  return turns.slice(-limit * 2)
}

export function createChatService(options) {
  const {
    getSettings,
    getApiKey,
    getPersonaText,
    getMemoryDigest,
    onExchange,
    persistTurn,
    persistClear,
    fetchImpl,
    log
  } = options
  const fetchJson = fetchImpl ?? globalThis.fetch

  /** 全部历史，按时间顺序。开机时由 hydrate() 从加密仓库接回来。 */
  const turns = []
  let busy = false

  /**
   * 从磁盘接回历史。只在当前内存为空时生效，避免覆盖正在进行的会话。
   * 兼容两种字段名：content（渲染侧）与 text（存储层）。
   */
  function hydrate(list) {
    if (!Array.isArray(list) || list.length === 0) return 0
    if (turns.length > 0) return 0
    // 与运行时窗口同一口径：重启后看到的历史长度不会突然缩水。
    const keep = Math.max(chatConfig().historyLimit * 2, 10)
    for (const item of list.slice(-Math.min(MAX_RESTORED_TURNS, keep))) {
      if (item === null || typeof item !== 'object') continue
      if (item.role !== 'user' && item.role !== 'assistant') continue
      const raw = typeof item.content === 'string' ? item.content : item.text
      const content = typeof raw === 'string' ? raw.trim() : ''
      if (content === '') continue
      turns.push({ role: item.role, content, at: typeof item.at === 'string' ? item.at : '' })
    }
    return turns.length
  }

  function readSettings() {
    return getSettings() ?? {}
  }

  function chatConfig() {
    const chat = readSettings().companion?.chat ?? {}
    const maxTokens = Number(chat.maxTokens)
    const temperature = Number(chat.temperature)
    const historyLimit = Number(chat.historyLimit)
    return {
      enabled: chat.enabled === true,
      // 设置层只存服务商名；不存端点，端点永远由这里决定。
      provider:
        typeof chat.provider === 'string' && chat.provider.trim() !== ''
          ? chat.provider.trim()
          : SUPPORTED_PROVIDER,
      model: typeof chat.model === 'string' && chat.model.trim() !== '' ? chat.model.trim() : 'deepseek-chat',
      maxTokens: Number.isFinite(maxTokens) ? Math.min(Math.max(Math.floor(maxTokens), 16), 4_000) : 800,
      temperature: Number.isFinite(temperature) ? Math.min(Math.max(temperature, 0), 2) : 0.8,
      historyLimit: Number.isFinite(historyLimit)
        ? Math.min(Math.max(Math.floor(historyLimit), 0), 50)
        : 10
    }
  }

  async function send(payload) {
    const text = typeof payload?.text === 'string' ? payload.text.trim() : ''
    if (text.length === 0) return { ok: false, reason: 'empty' }
    if (text.length > MAX_MESSAGE_CHARS) return { ok: false, reason: 'too-long' }

    const config = chatConfig()
    if (!config.enabled) return { ok: false, reason: 'disabled' }
    // 只有 deepseek 有固定端点；其他值视为配置损坏，明确拒绝，不猜一个地址。
    if (config.provider !== SUPPORTED_PROVIDER) {
      return { ok: false, reason: 'unsupported-provider', message: config.provider }
    }
    if (busy) return { ok: false, reason: 'busy' }

    let apiKey = null
    try {
      apiKey = await getApiKey()
    } catch (error) {
      return { ok: false, reason: 'vault-unavailable', message: String(error?.message ?? error) }
    }
    // 没配钥匙是正常状态：窗内写「未配置」，不弹错误框。
    if (apiKey === null || apiKey === '') return { ok: false, reason: 'no-key' }

    const settings = readSettings()
    const personaText = typeof getPersonaText === 'function' ? getPersonaText(settings) : ''
    const memoryText = typeof getMemoryDigest === 'function' ? getMemoryDigest() : ''
    const messages = [
      { role: 'system', content: composeSystemPrompt(personaText, memoryText) },
      ...trimTurns(turns, config.historyLimit),
      { role: 'user', content: text }
    ]

    const controller = new AbortController()
    let timer = null
    busy = true

    try {
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          reject(Object.assign(new Error('chat timeout'), { code: 'timeout' }))
        }, CHAT_TIMEOUT_MS)
      })

      const response = await Promise.race([
        fetchJson(CHAT_ENDPOINT, {
          method: 'POST',
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            Accept: 'application/json'
          },
          body: JSON.stringify({
            model: config.model,
            messages,
            temperature: config.temperature,
            max_tokens: config.maxTokens,
            stream: false
          })
        }),
        timeout
      ])

      if (!response.ok) {
        return { ok: false, reason: mapStatus(response.status), message: `HTTP ${response.status}` }
      }

      const body = await response.json()
      const reply = body?.choices?.[0]?.message?.content
      if (typeof reply !== 'string' || reply.trim() === '') {
        return { ok: false, reason: 'bad-response' }
      }

      const usage = body?.usage
      const at = new Date().toISOString()
      const answer = reply.trim()

      const userTurn = { role: 'user', content: text, at }
      const assistantTurn = { role: 'assistant', content: answer, at }
      turns.push(userTurn)
      turns.push(assistantTurn)

      // 两路落盘互不牵连：记忆供提示词用，历史供界面回看。
      // 任何一路失败都只记日志，不影响这次回复。
      if (typeof onExchange === 'function') {
        try {
          onExchange({ user: text, assistant: answer, at })
        } catch (error) {
          log?.('记忆写入回调失败：', String(error?.message ?? error))
        }
      }
      if (typeof persistTurn === 'function') {
        for (const turn of [userTurn, assistantTurn]) {
          try {
            persistTurn(turn)
          } catch (error) {
            log?.('聊天历史落盘失败：', String(error?.message ?? error))
          }
        }
      }

      // 内存里多留一点供界面回看，但送进模型的上下文严格按 historyLimit 裁。
      // 下限 10 条：就算把上下文设成 0，窗口里也不会只剩最后一句。
      const keep = Math.max(config.historyLimit * 2, 10)
      while (turns.length > keep) turns.shift()

      return {
        ok: true,
        reply: answer,
        model: typeof body?.model === 'string' ? body.model : config.model,
        usage:
          usage === undefined
            ? null
            : {
                inputTokens: Number.isFinite(Number(usage.prompt_tokens)) ? Number(usage.prompt_tokens) : null,
                outputTokens: Number.isFinite(Number(usage.completion_tokens))
                  ? Number(usage.completion_tokens)
                  : null
              },
        at
      }
    } catch (error) {
      if (error?.code === 'timeout' || error?.name === 'AbortError') {
        return { ok: false, reason: 'timeout' }
      }
      log?.('聊天请求失败：', error instanceof Error ? error.message : String(error))
      return { ok: false, reason: 'request-failed', message: String(error?.message ?? error) }
    } finally {
      if (timer !== null) clearTimeout(timer)
      busy = false
    }
  }

  function history() {
    return turns.map((turn) => ({ role: turn.role, content: turn.content, at: turn.at }))
  }

  async function clear() {
    // 清空也要落到磁盘：否则下次开机旧历史会被重新接回来。
    // 顺序固定：先等空记录落盘，成功后才清内存；失败时 turns 一字不动。
    if (typeof persistClear === 'function') {
      try {
        const result = await persistClear()
        if (result && result.ok === false) {
          return { ok: false, reason: String(result.reason ?? 'persist-failed') }
        }
      } catch (error) {
        log?.('聊天历史清空失败：', String(error?.message ?? error))
        return { ok: false, reason: 'persist-failed' }
      }
    }
    turns.length = 0
    return { ok: true }
  }

  function status() {
    const config = chatConfig()
    return {
      enabled: config.enabled,
      provider: config.provider,
      model: config.model,
      historyCount: turns.length,
      busy
    }
  }

  /**
   * 连接自检：用真实 Key 发一次最小请求，只看通不通。
   *
   * 不回密钥、不回完整响应；不写历史、不占 busy、不产生对话。
   * 12 秒还没回就当超时，避免设置页一直转。
   */
  async function test() {
    const config = chatConfig()
    let apiKey = null
    try {
      apiKey = await getApiKey()
    } catch {
      return { ok: false, reason: 'secret-store-unavailable' }
    }
    if (apiKey === null || apiKey === '') return { ok: false, reason: 'no-key' }

    const startedAt = Date.now()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 12000)
    try {
      const response = await fetchJson(CHAT_ENDPOINT, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json'
        },
        body: JSON.stringify({
          model: config.model,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1,
          stream: false
        })
      })
      const elapsedMs = Date.now() - startedAt
      if (!response.ok) {
        return { ok: false, reason: mapStatus(response.status), status: response.status, elapsedMs }
      }
      return { ok: true, model: config.model, status: response.status, elapsedMs }
    } catch (error) {
      const timedOut = error?.name === 'AbortError' || error?.code === 'timeout'
      return { ok: false, reason: timedOut ? 'timeout' : 'network-error' }
    } finally {
      clearTimeout(timer)
    }
  }

  return { send, hydrate, history, clear, status, test }
}

/** HTTP 状态映射到界面能直接说清楚的原因。 */
function mapStatus(status) {
  if (status === 401 || status === 403) return 'auth-failed'
  if (status === 402) return 'insufficient-balance'
  if (status === 429) return 'rate-limited'
  if (status >= 500) return 'server-error'
  return 'request-failed'
}
