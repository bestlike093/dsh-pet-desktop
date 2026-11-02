import { describe, expect, it, vi } from 'vitest'
import {
  SERVICE_IDS,
  createServiceRunner,
  resolveAll,
  resolveService,
  type ServiceDefinition
} from '../externalService'
import { TtlCache } from '../ttlCache'

const weatherDef = {
  id: 'weather',
  endpoint: 'https://api.example.test/weather',
  ttlMs: 60_000
}

describe('resolveService：缺什么就说什么', () => {
  it('完全没配置时，两项都缺', () => {
    const status = resolveService({}, 'weather')
    expect(status.configured).toBe(false)
    expect(status.missing).toEqual(['apiKey', 'endpoint'])
  })

  it('只填了 key、也没默认地址时，还缺 endpoint', () => {
    const status = resolveService({ weather: { apiKey: 'k' } }, 'weather')
    expect(status.missing).toEqual(['endpoint'])
  })

  it('只填了 key 且定义自带地址，就算配好了', () => {
    const status = resolveService({ weather: { apiKey: 'k' } }, 'weather', weatherDef)
    expect(status.configured).toBe(true)
    expect(status.missing).toEqual([])
  })

  it('自己的地址能覆盖定义自带的', () => {
    const status = resolveService(
      { weather: { apiKey: 'k', endpoint: 'https://proxy.test/w' } },
      'weather',
      weatherDef
    )
    expect(status.configured).toBe(true)
  })

  it('只有空格不算填了', () => {
    const status = resolveService({ weather: { apiKey: '   ' } }, 'weather', weatherDef)
    expect(status.missing).toEqual(['apiKey'])
  })

  it('空字符串也不算填了', () => {
    const status = resolveService({ weather: { apiKey: '' } }, 'weather', weatherDef)
    expect(status.missing).toEqual(['apiKey'])
  })

  it('各服务互不影响', () => {
    const config = { weather: { apiKey: 'k' } }
    expect(resolveService(config, 'weather', weatherDef).configured).toBe(true)
    expect(resolveService(config, 'translate').configured).toBe(false)
  })
})

describe('resolveAll：一次报全', () => {
  it('三个服务都列出来', () => {
    const statuses = resolveAll({}, {})
    expect(statuses.map((s) => s.id)).toEqual([...SERVICE_IDS])
    expect(statuses.every((s) => s.configured === false)).toBe(true)
  })

  it('配好的那个单独是 true', () => {
    const statuses = resolveAll({ exchangeRate: { apiKey: 'k' } }, {
      exchangeRate: { id: 'exchangeRate', endpoint: 'https://api.example.test/fx', ttlMs: 1000 }
    } as never)
    const fx = statuses.find((s) => s.id === 'exchangeRate')
    expect(fx?.configured).toBe(true)
  })
})

describe('createServiceRunner', () => {
  const definition: ServiceDefinition<{ city: string }, { temp: number }> = {
    id: 'weather',
    endpoint: 'https://api.example.test/weather',
    ttlMs: 60_000,
    buildRequest: (input, credential) => ({
      url: `${credential.endpoint}?city=${encodeURIComponent(input.city)}`,
      headers: { authorization: `Bearer ${credential.apiKey}` }
    }),
    parse: (raw) => ({ temp: (raw as { main: { temp: number } }).main.temp })
  }

  it('没配置时返回 null，不抛错', () => {
    const runner = createServiceRunner(definition, {}, { fetchImpl: vi.fn() })
    expect(runner).toBeNull()
  })

  it('配置后能拿到解析结果', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ main: { temp: 21 } }), { status: 200 })
    )
    const runner = createServiceRunner(definition, { weather: { apiKey: 'k' } }, { fetchImpl })
    expect(runner).not.toBeNull()
    await expect(runner?.({ city: '重庆' })).resolves.toEqual({ temp: 21 })
  })

  it('把 apiKey 放进请求头', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ main: { temp: 1 } }), { status: 200 })
    )
    const runner = createServiceRunner(definition, { weather: { apiKey: 'secret' } }, { fetchImpl })
    await runner?.({ city: 'x' })
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: 'Bearer secret' })
      })
    )
  })

  it('同样输入第二次走缓存，不再打接口', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ main: { temp: 21 } }), { status: 200 })
    )
    const runner = createServiceRunner(definition, { weather: { apiKey: 'k' } }, { fetchImpl })
    await runner?.({ city: '重庆' })
    await runner?.({ city: '重庆' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('换了 city 就是另一条缓存', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ main: { temp: 21 } }), { status: 200 })
    )
    const runner = createServiceRunner(definition, { weather: { apiKey: 'k' } }, { fetchImpl })
    await runner?.({ city: '重庆' })
    await runner?.({ city: '成都' })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('用户填的 endpoint 会替代定义里的地址', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ main: { temp: 1 } }), { status: 200 })
    )
    const runner = createServiceRunner(
      definition,
      { weather: { apiKey: 'k', endpoint: 'https://self.hosted/w' } },
      { fetchImpl }
    )
    await runner?.({ city: 'a' })
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://self.hosted/w?city=a',
      expect.anything()
    )
  })

  it('外部传入的缓存能复用', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ main: { temp: 21 } }), { status: 200 })
    )
    const cache = new TtlCache<unknown>(() => 1000)
    const runner = createServiceRunner(definition, { weather: { apiKey: 'k' } }, {
      fetchImpl,
      cache
    })
    await runner?.({ city: '重庆' })
    expect(cache.size).toBe(1)
  })
})
