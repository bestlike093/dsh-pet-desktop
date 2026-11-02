/**
 * 人格提示词拼装。
 *
 * 这里只负责把「设置里能改的东西」拼成一段稳定的 system 文本：
 * 基础设定 + 称呼 + 语言 + 额外说明。
 * 记忆片段由聊天服务另外拼接，不在这里混进来，方便单独预览。
 */

const BASE_ZH = [
  '你是一个常驻在用户桌面上的虚拟伙伴，用简体中文口语说话。',
  '回复保持简短自然，通常一到三句话，不用列表、不用标题、不用 Markdown 强调。',
  '你有自己的判断，也可以直接说出不同意见；不为了讨好而含糊其辞。',
  '不假装拥有现实中的身体，也不编造自己不知道的事实。'
]

const BASE_EN = [
  'You are a virtual companion living on the user\'s desktop. Speak in casual English.',
  'Keep replies short and natural, usually one to three sentences. No lists, headings, or Markdown emphasis.',
  'You have your own judgment and may disagree directly; do not blur the answer just to please.',
  'Do not pretend to have a physical body, and do not invent facts you do not know.'
]

/**
 * @param {object} settings 全量设置
 * @returns {{ text: string, sections: { base: boolean, nickname: boolean, extra: boolean } }}
 */
export function buildPersonaPrompt(settings) {
  const locale = settings?.locale === 'en-US' ? 'en-US' : 'zh-CN'
  const persona = settings?.companion?.persona ?? {}
  const enabled = persona.enabled !== false
  const nickname = String(settings?.nickname ?? '').trim()
  const extra = String(persona.extraPrompt ?? '').trim()

  if (!enabled) {
    return {
      text: locale === 'en-US' ? 'Be a concise, friendly desktop companion.' : '做一个简洁、友好的桌面对话伙伴。',
      sections: { base: false, nickname: false, extra: false }
    }
  }

  const lines = locale === 'en-US' ? [...BASE_EN] : [...BASE_ZH]

  if (nickname.length > 0) {
    lines.push(
      locale === 'en-US'
        ? `The user wants to be called "${nickname}".`
        : `用户希望你称呼对方为「${nickname}」。`
    )
  }

  if (extra.length > 0) {
    lines.push(locale === 'en-US' ? `Additional setting: ${extra}` : `补充设定：${extra}`)
  }

  return {
    text: lines.join('\n'),
    sections: { base: true, nickname: nickname.length > 0, extra: extra.length > 0 }
  }
}
