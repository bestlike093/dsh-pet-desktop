import { describe, expect, it } from 'vitest'
import { SERVICE_SCHEMAS, isSensitiveField, toFormModel, validateValues, type ServiceSchema } from '../serviceSchema'

const weather = SERVICE_SCHEMAS.find((s) => s.id === 'weather') as ServiceSchema
const translate = SERVICE_SCHEMAS.find((s) => s.id === 'translate') as ServiceSchema
const fx = SERVICE_SCHEMAS.find((s) => s.id === 'exchangeRate') as ServiceSchema
const llm = SERVICE_SCHEMAS.find((s) => s.id === 'llm') as ServiceSchema

describe('SERVICE_SCHEMAS：结构', () => {
  it('六个服务都在', () => {
    expect(SERVICE_SCHEMAS.map((s) => s.id)).toEqual([
      'weather',
      'exchangeRate',
      'translate',
      'llm',
      'bilibili',
      'game'
    ])
  })

  it('敏感字段都能被 isSensitiveField 认出来', () => {
    for (const schema of SERVICE_SCHEMAS) {
      for (const field of schema.fields) {
        if (field.type === 'secret' || field.sensitive === true) {
          expect(isSensitiveField(field), `${schema.id}.${field.key}`).toBe(true)
        }
      }
    }
  })

  it('有密钥字段的服务，密钥都是必填；有 endpoint 的都不是必填', () => {
    for (const schema of SERVICE_SCHEMAS) {
      const apiKey = schema.fields.find((f) => f.key === 'apiKey')
      if (apiKey !== undefined) expect(apiKey.required, schema.id).toBe(true)

      const endpoint = schema.fields.find((f) => f.key === 'endpoint')
      if (endpoint) expect(endpoint.required, schema.id).toBe(false)
    }
  })

  it('大模型的地址叫 baseUrl，且必须填', () => {
    const baseUrl = llm.fields.find((f) => f.key === 'baseUrl')
    expect(baseUrl?.required).toBe(true)
    expect(baseUrl?.type).toBe('url')
  })

  it('没写死任何服务商名字', () => {
    const text = JSON.stringify(SERVICE_SCHEMAS)
    for (const vendor of ['openweathermap', 'heweather', 'qweather', 'baidu', 'deepl']) {
      expect(text.toLowerCase()).not.toContain(vendor)
    }
  })
})

describe('validateValues：必填', () => {
  it('没填密钥时报错', () => {
    const errors = validateValues(weather, {})
    expect(errors).toHaveLength(1)
    expect(errors[0]?.key).toBe('apiKey')
    expect(errors[0]?.message).toContain('不能为空')
  })

  it('只有空格也算没填', () => {
    const errors = validateValues(weather, { apiKey: '  ' })
    expect(errors.map((e) => e.key)).toEqual(['apiKey'])
  })

  it('填了密钥且地址留空时不报错', () => {
    expect(validateValues(weather, { apiKey: 'k' })).toEqual([])
  })

  it('填了密钥和合法地址时不报错', () => {
    expect(validateValues(weather, { apiKey: 'k', endpoint: 'https://a.test/x' })).toEqual([])
  })
})

describe('validateValues：格式', () => {
  it('地址不是 http/https 就报错', () => {
    const errors = validateValues(weather, { apiKey: 'k', endpoint: 'a.test/x' })
    expect(errors.map((e) => e.key)).toEqual(['endpoint'])
    expect(errors[0]?.message).toContain('http')
  })

  it('ftp 地址也拦下', () => {
    const errors = validateValues(weather, { apiKey: 'k', endpoint: 'ftp://a.test/x' })
    expect(errors.map((e) => e.key)).toEqual(['endpoint'])
  })

  it('数字字段非数字时报错', () => {
    const errors = validateValues(translate, { apiKey: 'k', cacheSeconds: 'abc' })
    expect(errors.map((e) => e.key)).toEqual(['cacheSeconds'])
    expect(errors[0]?.message).toContain('数字')
  })

  it('数字超出上限时报错', () => {
    const errors = validateValues(translate, { apiKey: 'k', cacheSeconds: 99_999 })
    expect(errors[0]?.message).toContain('86400')
  })

  it('数字为负时报错', () => {
    const errors = validateValues(translate, { apiKey: 'k', cacheSeconds: -1 })
    expect(errors.map((e) => e.key)).toEqual(['cacheSeconds'])
  })

  it('下拉项不在范围内时报错', () => {
    const errors = validateValues(translate, { apiKey: 'k', target: 'fr' })
    expect(errors.map((e) => e.key)).toEqual(['target'])
  })

  it('下拉项合法时通过', () => {
    expect(validateValues(translate, { apiKey: 'k', target: 'en' })).toEqual([])
  })
})

describe('validateValues：一次报全', () => {
  it('多个字段同时错时全部列出', () => {
    const errors = validateValues(translate, {
      target: 'fr',
      cacheSeconds: -1
    })
    expect(errors.map((e) => e.key).sort()).toEqual(['apiKey', 'cacheSeconds', 'target'])
  })

  it('密钥错误信息里不含密钥值', () => {
    const errors = validateValues(weather, { apiKey: 'sk-should-not-leak' })
    const text = errors.map((e) => e.message).join(' ')
    expect(text).not.toContain('sk-should-not-leak')
  })
})

describe('validateValues：可选字段默认值', () => {
  it('汇率基准货币不填也能过', () => {
    expect(validateValues(fx, { apiKey: 'k' })).toEqual([])
  })

  it('翻译缓存不填也能过', () => {
    expect(validateValues(translate, { apiKey: 'k' })).toEqual([])
  })
})

describe('toFormModel', () => {
  it('没填的字段用默认值渲染', () => {
    const model = toFormModel(translate, { apiKey: 'k' })
    const cache = model.find((f) => f.key === 'cacheSeconds')
    expect(cache?.value).toBe(300)
    const target = model.find((f) => f.key === 'target')
    expect(target?.value).toBe('zh')
  })

  it('填了就用填的值，默认值不覆盖', () => {
    const model = toFormModel(translate, { apiKey: 'k', cacheSeconds: 60 })
    expect(model.find((f) => f.key === 'cacheSeconds')?.value).toBe(60)
  })

  it('错误挂在对应字段上', () => {
    const model = toFormModel(weather, {})
    const keyField = model.find((f) => f.key === 'apiKey')
    expect(keyField?.error).toContain('不能为空')
  })

  it('没错误的字段 error 为 null', () => {
    const model = toFormModel(weather, { apiKey: 'k' })
    expect(model.every((f) => f.error === null)).toBe(true)
  })

  it('字段顺序与 schema 一致', () => {
    const model = toFormModel(translate, {})
    expect(model.map((f) => f.key)).toEqual(
      translate.fields.map((f) => f.key)
    )
  })
})
