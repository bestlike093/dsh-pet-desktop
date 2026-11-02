import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_TIMEOUT_MS, HttpError, httpJson, type FetchLike } from '../httpJson'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

describe('httpJson：成功路径', () => {
  it('解析 JSON 返回', async () => {
    const fetchImpl: FetchLike = vi.fn(async () => jsonResponse({ ok: true, temp: 21 }))
    const data = await httpJson<{ ok: boolean; temp: number }>('https://example.test/a', fetchImpl)
    expect(data).toEqual({ ok: true, temp: 21 })
  })

  it('把 headers 原样带上', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}))
    await httpJson('https://example.test/a', fetchImpl, { headers: { 'x-key': 'v' } })
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://example.test/a',
      expect.objectContaining({ headers: { 'x-key': 'v' } })
    )
  })
})

describe('httpJson：四类失败分得开', () => {
  it('非 2xx 报 status，并带上状态码', async () => {
    const fetchImpl: FetchLike = async () => jsonResponse({ error: 'nope' }, 404)
    await expect(httpJson('https://example.test/a', fetchImpl)).rejects.toMatchObject({
      kind: 'status',
      status: 404
    })
  })

  it('500 也算 status，不当成网络问题', async () => {
    const fetchImpl: FetchLike = async () => jsonResponse({}, 500)
    await expect(httpJson('https://example.test/a', fetchImpl)).rejects.toMatchObject({
      kind: 'status',
      status: 500
    })
  })

  it('fetch 抛普通错误报 network', async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error('ECONNREFUSED')
    }
    await expect(httpJson('https://example.test/a', fetchImpl)).rejects.toMatchObject({
      kind: 'network'
    })
  })

  it('返回 HTML 报 parse，不静默当空数据', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response('<html><body>login</body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' }
      })
    await expect(httpJson('https://example.test/a', fetchImpl)).rejects.toMatchObject({
      kind: 'parse'
    })
  })

  it('超时报 timeout', async () => {
    const fetchImpl: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const error = new Error('aborted')
          error.name = 'AbortError'
          reject(error)
        })
      })

    await expect(httpJson('https://example.test/a', fetchImpl, { timeoutMs: 5 })).rejects.toMatchObject({
      kind: 'timeout'
    })
  })
})

describe('httpJson：错误对象本身', () => {
  it('带 url 和 name，方便日志定位', async () => {
    const fetchImpl: FetchLike = async () => jsonResponse({}, 403)
    const error = await httpJson('https://example.test/x', fetchImpl).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(HttpError)
    expect((error as HttpError).url).toBe('https://example.test/x')
    expect((error as HttpError).name).toBe('HttpError')
  })

  it('status 失败时 kind 与 status 同时可读', async () => {
    const fetchImpl: FetchLike = async () => jsonResponse({}, 429)
    const error = (await httpJson('https://example.test/x', fetchImpl).catch(
      (e: unknown) => e
    )) as HttpError
    expect(error.kind).toBe('status')
    expect(error.status).toBe(429)
  })
})

describe('httpJson：协议与响应体上限', () => {
  it('非 http/https 协议直接拒绝，不调用 fetch', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}))
    await expect(httpJson('file:///etc/passwd', fetchImpl)).rejects.toMatchObject({
      kind: 'network'
    })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('响应体超过 maxResponseBytes 报 too-large', async () => {
    const fetchImpl: FetchLike = async () => new Response('x'.repeat(100))
    await expect(
      httpJson('https://example.test/a', fetchImpl, { maxResponseBytes: 10 })
    ).rejects.toMatchObject({ kind: 'too-large' })
  })
})

describe('httpJson：超时参数', () => {
  it('默认 8 秒', () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(8000)
  })

  it('timeoutMs 覆盖 defaultTimeoutMs', async () => {
    const fetchImpl: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const error = new Error('aborted')
          error.name = 'AbortError'
          reject(error)
        })
      })

    await expect(
      httpJson('https://example.test/a', fetchImpl, { timeoutMs: 5, defaultTimeoutMs: 60_000 })
    ).rejects.toMatchObject({ kind: 'timeout' })
  })
})
