import { describe, expect, it } from 'vitest'
import {
  buildMessage,
  decodeHeader,
  encodeHeader,
  formatAddress,
  parseHeaders,
  parseMessage,
  wrapBase64,
  type OutgoingMail
} from '../mime'

const fixedDate = new Date('2026-10-31T15:00:00Z')

function plainMail(overrides: Partial<OutgoingMail> = {}): OutgoingMail {
  return {
    from: { address: 'me@test.com', name: '我' },
    to: [{ address: 'you@test.com' }],
    subject: '测试主题',
    text: '这是一封测试邮件。',
    date: fixedDate,
    ...overrides
  }
}

describe('头部编码', () => {
  it('纯 ASCII 不编码', () => {
    expect(encodeHeader('Hello World')).toBe('Hello World')
  })

  it('中文走 base64', () => {
    const encoded = encodeHeader('测试')
    expect(encoded.startsWith('=?UTF-8?B?')).toBe(true)
    expect(decodeHeader(encoded)).toBe('测试')
  })

  it('解码不认识的编码时原样返回', () => {
    expect(decodeHeader('=?gb2312?B?xxx?=')).toBe('=?gb2312?B?xxx?=')
  })

  it('带名字的地址', () => {
    expect(formatAddress({ address: 'a@b.com', name: '小鹿' })).toContain('a@b.com')
  })

  it('名字里有逗号时加引号', () => {
    expect(formatAddress({ address: 'a@b.com', name: 'Doe, John' })).toContain('"Doe, John"')
  })

  it('没有名字时只留地址', () => {
    expect(formatAddress({ address: 'a@b.com' })).toBe('a@b.com')
  })
})

describe('拼接邮件', () => {
  it('包含必要头部', () => {
    const raw = buildMessage(plainMail())
    expect(raw).toContain('From:')
    expect(raw).toContain('To: you@test.com')
    expect(raw).toContain('Subject: =?UTF-8?B?')
    expect(raw).toContain('MIME-Version: 1.0')
    expect(raw).toContain('Date:')
  })

  it('纯文本用 base64 传输', () => {
    const raw = buildMessage(plainMail())
    expect(raw).toContain('Content-Transfer-Encoding: base64')
  })

  it('带 HTML 时是 multipart/alternative', () => {
    const raw = buildMessage(plainMail({ html: '<p>hi</p>' }))
    expect(raw).toContain('multipart/alternative')
    expect(raw).toContain('text/html')
  })

  it('带附件时是 multipart/mixed', () => {
    const raw = buildMessage(
      plainMail({
        attachments: [
          { filename: 'a.txt', contentType: 'text/plain', data: new Uint8Array([104, 105]) }
        ]
      })
    )
    expect(raw).toContain('multipart/mixed')
    expect(raw).toContain('Content-Disposition: attachment')
  })

  it('抄送出现在头部', () => {
    const raw = buildMessage(plainMail({ cc: [{ address: 'cc@test.com' }] }))
    expect(raw).toContain('Cc: cc@test.com')
  })

  it('自定义头被写入', () => {
    const raw = buildMessage(plainMail({ headers: { 'Reply-To': 'r@test.com' } }))
    expect(raw).toContain('Reply-To: r@test.com')
  })
})

describe('解析邮件', () => {
  it('解析基本头部', () => {
    const raw = [
      'From: A <a@test.com>',
      'To: b@test.com, c@test.com',
      'Subject: Hello',
      'Date: Sat, 31 Oct 2026 15:00:00 +0000',
      '',
      'body'
    ].join('\r\n')

    const mail = parseMessage(raw)
    expect(mail.subject).toBe('Hello')
    expect(mail.from?.address).toBe('a@test.com')
    expect(mail.from?.name).toBe('A')
    expect(mail.to).toHaveLength(2)
    expect(mail.date).toBe('Sat, 31 Oct 2026 15:00:00 +0000')
  })

  it('展开折行头', () => {
    const raw = ['Subject: 这是一段', ' 被折行的主题', '', 'body'].join('\r\n')
    const mail = parseMessage(raw)
    expect(mail.subject).toBe('这是一段 被折行的主题')
  })

  it('头键统一小写', () => {
    const headers = parseHeaders('Content-Type: text/plain\r\nX-Custom: 1')
    expect(headers['content-type']).toEqual(['text/plain'])
    expect(headers['x-custom']).toEqual(['1'])
  })

  it('base64 正文被解开', () => {
    const body = Buffer.from('中文正文', 'utf8').toString('base64')
    const raw = [
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '',
      body
    ].join('\r\n')

    expect(parseMessage(raw).text).toBe('中文正文')
  })

  it('quoted-printable 被解开', () => {
    const raw = [
      'Content-Type: text/plain',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      'caf=C3=A9'
    ].join('\r\n')

    expect(parseMessage(raw).text).toBe('café')
  })

  it('HTML 正文同时给出纯文本', () => {
    const raw = [
      'Content-Type: text/html; charset=utf-8',
      '',
      '<p>第一段</p><p>第二段</p>'
    ].join('\r\n')

    const mail = parseMessage(raw)
    expect(mail.html).toContain('<p>')
    expect(mail.text).toContain('第一段')
    expect(mail.text).toContain('第二段')
  })

  it('multipart 里取到纯文本', () => {
    const boundary = 'BOUND'
    const raw = [
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from('纯文本部分', 'utf8').toString('base64'),
      `--${boundary}`,
      'Content-Type: text/html; charset=utf-8',
      '',
      '<p>HTML 部分</p>',
      `--${boundary}--`
    ].join('\r\n')

    const mail = parseMessage(raw)
    expect(mail.text).toBe('纯文本部分')
    expect(mail.html).toContain('HTML 部分')
  })

  it('识别附件，不把附件当正文', () => {
    const boundary = 'MIX'
    const raw = [
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain',
      '',
      '正文',
      `--${boundary}`,
      'Content-Type: application/pdf; name="a.pdf"',
      'Content-Disposition: attachment; filename="a.pdf"',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from('PDFDATA').toString('base64'),
      `--${boundary}--`
    ].join('\r\n')

    const mail = parseMessage(raw)
    expect(mail.text).toBe('正文')
    expect(mail.attachments).toHaveLength(1)
    expect(mail.attachments[0]?.filename).toBe('a.pdf')
  })
})

describe('往返一致', () => {
  it('拼出来再解开，主题与正文不变', () => {
    const raw = buildMessage(
      plainMail({
        subject: '关于今晚的进度',
        text: '今天做到 13/26 了♪'
      })
    )

    const mail = parseMessage(raw)
    expect(mail.subject).toBe('关于今晚的进度')
    expect(mail.text.trim()).toBe('今天做到 13/26 了♪')
  })

  it('带附件往返后附件还在', () => {
    const raw = buildMessage(
      plainMail({
        attachments: [
          {
            filename: '报告.txt',
            contentType: 'text/plain',
            data: new TextEncoder().encode('内容')
          }
        ]
      })
    )

    const mail = parseMessage(raw)
    expect(mail.attachments).toHaveLength(1)
    expect(mail.attachments[0]?.filename).toBe('报告.txt')
    expect(mail.attachments[0]?.bytes).toBeGreaterThan(0)
  })

  it('HTML 往返保留标签', () => {
    const raw = buildMessage(plainMail({ text: '纯文本', html: '<b>加粗</b>' }))
    const mail = parseMessage(raw)
    expect(mail.html).toContain('<b>加粗</b>')
  })
})

describe('工具函数', () => {
  it('base64 每 76 字符折行', () => {
    const wrapped = wrapBase64('a'.repeat(200))
    const lines = wrapped.split('\r\n')
    expect(lines.every((line) => line.length <= 76)).toBe(true)
  })

  it('空正文不抛错', () => {
    const raw = buildMessage(plainMail({ text: '' }))
    expect(() => parseMessage(raw)).not.toThrow()
  })
})
