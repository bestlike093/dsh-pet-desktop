/**
 * 邮件内容的编码与解码。
 *
 * 只做「怎么把一封信拼成字节」和「怎么从字节里读回首部」，
 * 不管 SMTP 怎么连——那是宿主的事。
 *
 * 对应能力：`io.mail.send`、`io.mail.read`。
 */

export interface MailAddress {
  readonly address: string
  readonly name?: string
}

export interface MailAttachment {
  readonly filename: string
  readonly contentType?: string
  readonly data: Uint8Array
}

export interface OutgoingMail {
  readonly from: MailAddress
  readonly to: readonly MailAddress[]
  readonly cc?: readonly MailAddress[]
  readonly bcc?: readonly MailAddress[]
  readonly subject: string
  readonly text?: string
  readonly html?: string
  readonly attachments?: readonly MailAttachment[]
  /** 生成时间，默认当前时间。测试可传入固定值。 */
  readonly date?: Date
  /** 额外头，比如 `Reply-To`。 */
  readonly headers?: Readonly<Record<string, string>>
}

export interface ParsedMail {
  readonly subject: string
  readonly from: MailAddress | null
  readonly to: readonly MailAddress[]
  readonly date: string | null
  /** 所有头，键小写。重复头用数组。 */
  readonly headers: Readonly<Record<string, readonly string[]>>
  /** 纯文本正文。取不到时为空串。 */
  readonly text: string
  readonly html: string | null
  readonly attachments: readonly ParsedAttachment[]
}

export interface ParsedAttachment {
  readonly filename: string
  readonly contentType: string
  readonly bytes: number
}

const CRLF = '\r\n'

/**
 * 拼一封信。
 *
 * 结构：
 * - 纯文本 → 直接是正文
 * - 纯文本 + HTML → multipart/alternative
 * - 有附件 → 外面再套 multipart/mixed
 */
export function buildMessage(mail: OutgoingMail): string {
  const date = mail.date ?? new Date()
  const boundaryMixed = `=_mixed_${randomToken()}`
  const boundaryAlt = `=_alt_${randomToken()}`

  const hasHtml = typeof mail.html === 'string' && mail.html.length > 0
  const hasAttachments = (mail.attachments?.length ?? 0) > 0

  const headers: string[] = [
    `From: ${formatAddress(mail.from)}`,
    `To: ${mail.to.map(formatAddress).join(', ')}`,
    `Subject: ${encodeHeader(mail.subject)}`,
    `Date: ${formatDate(date)}`,
    `MIME-Version: 1.0`
  ]

  if (mail.cc !== undefined && mail.cc.length > 0) {
    headers.push(`Cc: ${mail.cc.map(formatAddress).join(', ')}`)
  }

  if (mail.headers !== undefined) {
    for (const [key, value] of Object.entries(mail.headers)) {
      headers.push(`${key}: ${encodeHeader(value)}`)
    }
  }

  let body: string

  if (hasAttachments) {
    headers.push(`Content-Type: multipart/mixed; boundary="${boundaryMixed}"`)
    body = [
      '',
      '',
      `--${boundaryMixed}`,
      ...buildBodyPart(mail, hasHtml, boundaryAlt),
      `--${boundaryMixed}`,
      ...buildAttachmentParts(mail.attachments ?? []),
      `--${boundaryMixed}--`,
      ''
    ].join(CRLF)
  } else if (hasHtml) {
    headers.push(`Content-Type: multipart/alternative; boundary="${boundaryAlt}"`)
    body = ['', '', ...buildBodyPart(mail, true, boundaryAlt), `--${boundaryAlt}--`, ''].join(CRLF)
  } else {
    headers.push('Content-Type: text/plain; charset="utf-8"')
    headers.push('Content-Transfer-Encoding: base64')
    body = ['', '', wrapBase64(base64(new TextEncoder().encode(mail.text ?? '')))].join(CRLF)
  }

  return `${headers.join(CRLF)}${body}`
}

function buildBodyPart(mail: OutgoingMail, hasHtml: boolean, boundary: string): string[] {
  const textPart = [
    `--${boundary}`,
    'Content-Type: text/plain; charset="utf-8"',
    'Content-Transfer-Encoding: base64',
    '',
    wrapBase64(base64(new TextEncoder().encode(mail.text ?? '')))
  ]

  if (!hasHtml) return textPart

  const htmlPart = [
    `--${boundary}`,
    'Content-Type: text/html; charset="utf-8"',
    'Content-Transfer-Encoding: base64',
    '',
    wrapBase64(base64(new TextEncoder().encode(mail.html ?? '')))
  ]

  return [...textPart, ...htmlPart]
}

function buildAttachmentParts(attachments: readonly MailAttachment[]): string[] {
  const parts: string[] = []

  for (const attachment of attachments) {
    const type = attachment.contentType ?? 'application/octet-stream'
    parts.push(
      '',
      'Content-Type: ' + `${type}; name="${encodeHeader(attachment.filename)}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${encodeHeader(attachment.filename)}"`,
      '',
      wrapBase64(base64(attachment.data))
    )
  }

  return parts
}

/**
 * RFC 2047 编码：非 ASCII 走 base64。
 *
 * 纯 ASCII 原样返回，避免把普通英文主题也编码成看不懂的样子。
 */
export function encodeHeader(text: string): string {
  const value = String(text ?? '')
  if (/^[\x20-\x7e]*$/.test(value)) return value

  const bytes = new TextEncoder().encode(value)
  return `=?UTF-8?B?${base64(bytes)}?=`
}

export function formatAddress(address: MailAddress): string {
  const clean = address.address.trim()
  if (address.name === undefined || address.name.trim().length === 0) return clean

  const name = encodeHeader(address.name.trim())
  const quoted = /[,<>@;:\\"]/.test(address.name) ? `"${name.replace(/"/g, '\\"')}"` : name
  return `${quoted} <${clean}>`
}

function formatDate(date: Date): string {
  // toUTCString 的格式是 RFC 1123，邮件标准接受。
  return date.toUTCString().replace('GMT', '+0000')
}

/**
 * 解析一封邮件。
 *
 * 目标是「读得懂内容」，不追求完整的 MIME 树。
 * 遇到嵌套 multipart 时递归，取第一个 text/plain 与 text/html。
 */
export function parseMessage(raw: string): ParsedMail {
  const source = String(raw ?? '').replace(/\r\n?/g, '\n')
  const splitAt = source.indexOf('\n\n')
  const headText = splitAt >= 0 ? source.slice(0, splitAt) : source
  const bodyText = splitAt >= 0 ? source.slice(splitAt + 2) : ''

  const headers = parseHeaders(headText)
  const contentType = first(headers, 'content-type') ?? 'text/plain'

  const parsed = readBody(
    bodyText,
    contentType,
    first(headers, 'content-transfer-encoding')
  )

  return {
    subject: decodeHeader(first(headers, 'subject') ?? ''),
    from: parseAddress(first(headers, 'from') ?? ''),
    to: splitAddresses(first(headers, 'to') ?? ''),
    date: first(headers, 'date') ?? null,
    headers,
    text: parsed.text,
    html: parsed.html,
    attachments: parsed.attachments
  }
}

/** 展开折行头，键统一小写，值保持原样。 */
export function parseHeaders(headText: string): Record<string, readonly string[]> {
  const result: Record<string, string[]> = {}
  const lines = headText.split('\n')
  let currentKey: string | null = null

  for (const line of lines) {
    if (line.length === 0) continue

    // 以空白开头表示上一行的延续
    if (/^[ \t]/.test(line) && currentKey !== null) {
      const list = result[currentKey]
      if (list !== undefined && list.length > 0) {
        list[list.length - 1] = `${list[list.length - 1]} ${line.trim()}`
      }
      continue
    }

    const colon = line.indexOf(':')
    if (colon <= 0) continue

    const key = line.slice(0, colon).trim().toLowerCase()
    const value = line.slice(colon + 1).trim()
    ;(result[key] ??= []).push(value)
    currentKey = key
  }

  return result
}

function first(headers: Record<string, readonly string[]>, key: string): string | undefined {
  return headers[key]?.[0]
}

/** 解 RFC 2047 编码。不支持时原样返回。 */
export function decodeHeader(value: string): string {
  return value.replace(/=\?utf-8\?b\?([^?]+)\?=/gi, (_, payload: string) => {
    try {
      return new TextDecoder().decode(fromBase64(payload))
    } catch {
      return _
    }
  })
}

function parseAddress(value: string): MailAddress | null {
  const trimmed = value.trim()
  if (trimmed.length === 0) return null

  const match = /^(.*)<([^>]+)>$/.exec(trimmed)
  if (match === null) return { address: trimmed }

  const name = decodeHeader(match[1]?.trim().replace(/^"|"$/g, '') ?? '')
  return { address: match[2]?.trim() ?? '', name: name.length > 0 ? name : undefined }
}

function splitAddresses(value: string): MailAddress[] {
  if (value.trim().length === 0) return []

  // 简单按逗号分，忽略引号内的逗号
  const parts: string[] = []
  let buffer = ''
  let quoted = false

  for (const ch of value) {
    if (ch === '"') quoted = !quoted
    if (ch === ',' && !quoted) {
      parts.push(buffer)
      buffer = ''
      continue
    }
    buffer += ch
  }
  if (buffer.trim().length > 0) parts.push(buffer)

  return parts.map(parseAddress).filter((a): a is MailAddress => a !== null)
}

interface BodyParts {
  text: string
  html: string | null
  attachments: ParsedAttachment[]
}

function readBody(body: string, contentType: string, encoding?: string): BodyParts {
  const lower = contentType.toLowerCase()

  if (lower.startsWith('multipart/')) {
    const boundary = extractBoundary(contentType)
    if (boundary === null) return { text: '', html: null, attachments: [] }

    const chunks = splitByBoundary(body, boundary)
    const result: BodyParts = { text: '', html: null, attachments: [] }

    for (const chunk of chunks) {
      const splitAt = chunk.indexOf('\n\n')
      const headText = splitAt >= 0 ? chunk.slice(0, splitAt) : chunk
      const partBody = splitAt >= 0 ? chunk.slice(splitAt + 2) : ''
      const partHeaders = parseHeaders(headText)
      const partType = first(partHeaders, 'content-type') ?? 'text/plain'

      const disposition = first(partHeaders, 'content-disposition') ?? ''
      if (disposition.toLowerCase().startsWith('attachment')) {
        const filename = extractFilename(headText) ?? 'attachment'
        const decoded = decodeBody(partBody, first(partHeaders, 'content-transfer-encoding'))
        result.attachments.push({
          filename,
          contentType: partType.split(';')[0]?.trim() ?? 'application/octet-stream',
          bytes: decoded.length
        })
        continue
      }

      const nested = readBody(
        partBody,
        partType,
        first(partHeaders, 'content-transfer-encoding')
      )
      if (result.text.length === 0 && nested.text.length > 0) result.text = nested.text
      if (result.html === null && nested.html !== null) result.html = nested.html
      result.attachments.push(...nested.attachments)
    }

    return result
  }

  const decoded = decodeBody(body, encoding)
  const text = new TextDecoder().decode(decoded)

  if (lower.startsWith('text/html')) return { text: stripHtml(text), html: text, attachments: [] }
  return { text, html: null, attachments: [] }
}

function decodeBody(body: string, encoding: string | undefined): Uint8Array {
  const kind = (encoding ?? '').toLowerCase()

  if (kind === 'base64') {
    try {
      return fromBase64(body)
    } catch {
      return new TextEncoder().encode(body)
    }
  }

  if (kind === 'quoted-printable') {
    return decodeQuotedPrintable(body)
  }

  return new TextEncoder().encode(body)
}

function extractBoundary(contentType: string): string | null {
  const match = /boundary="?([^";]+)"?/i.exec(contentType)
  return match?.[1]?.trim() ?? null
}

function splitByBoundary(body: string, boundary: string): string[] {
  const marker = `--${boundary}`
  return body
    .split(marker)
    .slice(1)
    .map((chunk) => (chunk.startsWith('--') ? '' : chunk.replace(/^\n/, '').replace(/\n$/, '')))
    .filter((chunk) => chunk.length > 0)
}

function extractFilename(headText: string): string | null {
  const match = /filename\*?=(?:"([^"]+)"|([^;\s]+))/i.exec(headText)
  const value = match?.[1] ?? match?.[2]
  return value === undefined ? null : decodeHeader(value)
}

function decodeQuotedPrintable(body: string): Uint8Array {
  const joined = body.replace(/=\n/g, '')
  const bytes: number[] = []

  for (let i = 0; i < joined.length; i += 1) {
    const ch = joined.charAt(i)
    if (ch === '=' && /^[0-9A-Fa-f]{2}$/.test(joined.slice(i + 1, i + 3))) {
      bytes.push(Number.parseInt(joined.slice(i + 1, i + 3), 16))
      i += 2
      continue
    }
    bytes.push(ch.charCodeAt(0) & 0xff)
  }

  return new Uint8Array(bytes)
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim()
}

function base64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i] as number)
  }
  return btoa(binary)
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text.replace(/\s/g, ''))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** 每 76 字符折一行，符合 MIME 习惯。 */
export function wrapBase64(text: string, width = 76): string {
  const lines: string[] = []
  for (let i = 0; i < text.length; i += width) lines.push(text.slice(i, i + width))
  return lines.join(CRLF)
}

function randomToken(): string {
  const g = globalThis as unknown as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }
  const bytes = new Uint8Array(8)
  if (g.crypto?.getRandomValues !== undefined) {
    g.crypto.getRandomValues(bytes)
  } else {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256)
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}
