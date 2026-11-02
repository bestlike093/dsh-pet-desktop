import { describe, expect, it } from 'vitest'
import {
  SERVICE_SCHEMAS,
  isSensitiveField,
  persistSecrets,
  redactValues,
  sensitiveKeys,
  splitForStorage,
  type SecretWriter,
  type ServiceSchema
} from '../serviceSchema'
import { SERVICE_IDS, resolveService } from '../externalService'

const llm = SERVICE_SCHEMAS.find((s) => s.id === 'llm') as ServiceSchema
const weather = SERVICE_SCHEMAS.find((s) => s.id === 'weather') as ServiceSchema

function fakeWriter(): {
  writer: SecretWriter
  written: Array<{ id: string; field: string; value: string }>
  cleared: Array<{ id: string; field: string }>
} {
  const written: Array<{ id: string; field: string; value: string }> = []
  const cleared: Array<{ id: string; field: string }> = []
  const writer: SecretWriter = {
    set: async (id, value, field = 'apiKey') => {
      written.push({ id, field, value })
    },
    clear: async (id, field = 'apiKey') => {
      cleared.push({ id, field })
    }
  }
  return { writer, written, cleared }
}

describe('大模型的填入口', () => {
  it('注册表里有 llm', () => {
    expect(SERVICE_SCHEMAS.map((s) => s.id)).toContain('llm')
  })

  it('服务 id 列表里有 llm', () => {
    expect(SERVICE_IDS).toContain('llm')
  })

  it('llm 的必填项是密钥、地址、模型名', () => {
    const required = llm.fields.filter((f) => f.required).map((f) => f.key)
    expect(required.sort()).toEqual(['apiKey', 'baseUrl', 'model'])
  })

  it('没有写死任何服务商', () => {
    const text = JSON.stringify(llm).toLowerCase()
    for (const vendor of ['openai', 'deepseek', 'anthropic', 'qwen', 'moonshot']) {
      expect(text).not.toContain(vendor)
    }
  })

  it('地址和代理都是可选的敏感项外的情况也能用', () => {
    const keys = llm.fields.map((f) => f.key)
    expect(keys).toContain('proxy')
    expect(keys).toContain('temperature')
  })
})

describe('隐私判定', () => {
  it('secret 类型自动算敏感', () => {
    const field = llm.fields.find((f) => f.key === 'apiKey')!
    expect(isSensitiveField(field)).toBe(true)
  })

  it('标了 sensitive 的 url 算敏感', () => {
    const field = llm.fields.find((f) => f.key === 'baseUrl')!
    expect(isSensitiveField(field)).toBe(true)
  })

  it('代理地址算敏感', () => {
    const field = llm.fields.find((f) => f.key === 'proxy')!
    expect(isSensitiveField(field)).toBe(true)
  })

  it('模型名与温度不算敏感', () => {
    for (const key of ['model', 'temperature']) {
      const field = llm.fields.find((f) => f.key === key)!
      expect(isSensitiveField(field), key).toBe(false)
    }
  })

  it('所有服务的接口地址都算敏感', () => {
    for (const schema of SERVICE_SCHEMAS) {
      const endpoint = schema.fields.find((f) => f.key === 'endpoint' || f.key === 'baseUrl')
      if (endpoint) expect(isSensitiveField(endpoint), schema.id).toBe(true)
    }
  })

  it('天气服务的地址也是敏感项', () => {
    const endpoint = weather.fields.find((f) => f.key === 'endpoint')!
    expect(isSensitiveField(endpoint)).toBe(true)
  })

  it('sensitiveKeys 列出该服务要加密的项', () => {
    expect([...sensitiveKeys(llm)].sort()).toEqual(['apiKey', 'baseUrl', 'proxy'])
  })
})

describe('拆分存储', () => {
  const values = {
    apiKey: 'sk-123',
    baseUrl: 'http://192.168.1.9:8080/v1',
    model: 'my-model',
    proxy: 'http://127.0.0.1:7890',
    temperature: 0.5
  }

  it('敏感项进 secrets', () => {
    const { secrets } = splitForStorage(llm, values)
    expect(secrets).toEqual({
      apiKey: 'sk-123',
      baseUrl: 'http://192.168.1.9:8080/v1',
      proxy: 'http://127.0.0.1:7890'
    })
  })

  it('非敏感项进 plain', () => {
    const { plain } = splitForStorage(llm, values)
    expect(plain).toEqual({ model: 'my-model', temperature: 0.5 })
  })

  it('内网地址不会出现在 plain 里', () => {
    const { plain } = splitForStorage(llm, values)
    expect(JSON.stringify(plain)).not.toContain('192.168')
  })

  it('没填的字段两边都不出现', () => {
    const { secrets, plain } = splitForStorage(llm, { apiKey: 'k' })
    expect(secrets).toEqual({ apiKey: 'k' })
    expect(plain).toEqual({})
  })

  it('空白值不进 secrets，避免覆盖已存的值', () => {
    const { secrets } = splitForStorage(llm, { apiKey: '   ', baseUrl: '' })
    expect(secrets).toEqual({})
  })

  it('值写进去前 trim', () => {
    const { secrets } = splitForStorage(llm, { apiKey: '  sk-a  ' })
    expect(secrets.apiKey).toBe('sk-a')
  })
})

describe('日志脱敏', () => {
  it('敏感项被替换成固定星号串', () => {
    const redacted = redactValues(llm, {
      apiKey: 'sk-very-secret',
      baseUrl: 'http://10.0.0.5:9000',
      model: 'm1'
    })
    expect(redacted.apiKey).toBe('********')
    expect(redacted.baseUrl).toBe('********')
    expect(redacted.model).toBe('m1')
  })

  it('脱敏后的文本不含原始隐私', () => {
    const text = JSON.stringify(
      redactValues(llm, { baseUrl: 'http://10.0.0.5:9000', proxy: 'http://1.2.3.4:8080' })
    )
    expect(text).not.toContain('10.0.0.5')
    expect(text).not.toContain('1.2.3.4')
  })

  it('不同长度的密钥脱敏后长度一致', () => {
    const a = redactValues(llm, { apiKey: 'a'.repeat(8) })
    const b = redactValues(llm, { apiKey: 'a'.repeat(64) })
    expect(a.apiKey).toBe(b.apiKey)
  })
})

describe('写入加密仓库', () => {
  it('敏感项逐项写入', async () => {
    const { writer, written } = fakeWriter()
    await persistSecrets(writer, llm, {
      apiKey: 'sk-1',
      baseUrl: 'http://10.0.0.5',
      model: 'm'
    })
    expect(written.map((w) => w.field).sort()).toEqual(['apiKey', 'baseUrl'])
    expect(written.every((w) => w.id === 'llm')).toBe(true)
  })

  it('非敏感项不写入', async () => {
    const { writer, written } = fakeWriter()
    await persistSecrets(writer, llm, { apiKey: 'sk-1', model: 'm', temperature: 0.3 })
    expect(written.map((w) => w.field)).toEqual(['apiKey'])
  })

  it('返回写入与清除的字段名', async () => {
    const { writer } = fakeWriter()
    const result = await persistSecrets(writer, llm, { apiKey: 'sk-1' }, ['proxy'])
    expect(result.written).toEqual(['apiKey'])
    expect(result.cleared).toEqual(['proxy'])
  })

  it('清除列表里的非敏感项被忽略', async () => {
    const { writer, cleared } = fakeWriter()
    const result = await persistSecrets(writer, llm, {}, ['model'])
    expect(result.cleared).toEqual([])
    expect(cleared).toEqual([])
  })

  it('不传清除列表时不清任何东西', async () => {
    const { writer, cleared } = fakeWriter()
    await persistSecrets(writer, llm, { apiKey: 'sk-1' })
    expect(cleared).toEqual([])
  })
})

describe('大模型的配置检查', () => {
  it('三项都填才算配好', () => {
    const status = resolveService(
      { llm: { apiKey: 'k', baseUrl: 'https://x.test', model: 'm' } },
      'llm'
    )
    expect(status.configured).toBe(true)
  })

  it('缺模型名时明确指出来', () => {
    const status = resolveService({ llm: { apiKey: 'k', baseUrl: 'https://x.test' } }, 'llm')
    expect(status.configured).toBe(false)
    expect(status.missing).toContain('model')
  })

  it('baseUrl 可以顶替 endpoint', () => {
    const status = resolveService({ llm: { apiKey: 'k', baseUrl: 'https://x.test', model: 'm' } }, 'llm')
    expect(status.missing).not.toContain('endpoint')
  })

  it('其他服务不需要模型名', () => {
    const status = resolveService({ weather: { apiKey: 'k', endpoint: 'https://x.test' } }, 'weather')
    expect(status.configured).toBe(true)
  })
})
