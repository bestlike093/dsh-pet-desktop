import { describe, expect, it } from 'vitest'
import {
  SERVICE_SCHEMAS,
  isSensitiveField,
  redactValues,
  splitForStorage,
  type SecretWriter,
  type ServiceSchema
} from '../../net/serviceSchema'
import {
  PERSONAL_FIELDS,
  PERSONAL_SCOPE,
  persistPersonal,
  redactPersonal,
  splitPersonal,
  validatePersonal
} from '../personalInfo'

const bili = SERVICE_SCHEMAS.find((s) => s.id === 'bilibili') as ServiceSchema
const game = SERVICE_SCHEMAS.find((s) => s.id === 'game') as ServiceSchema

function fakeWriter(): {
  writer: SecretWriter
  written: Array<{ scope: string; field: string; value: string }>
  cleared: Array<{ scope: string; field: string }>
} {
  const written: Array<{ scope: string; field: string; value: string }> = []
  const cleared: Array<{ scope: string; field: string }> = []
  const writer: SecretWriter = {
    set: async (scope, value, field = 'apiKey') => {
      written.push({ scope, field, value })
    },
    clear: async (scope, field = 'apiKey') => {
      cleared.push({ scope, field })
    }
  }
  return { writer, written, cleared }
}

describe('B 站账号表', () => {
  it('Cookie 是密码框且必填', () => {
    const field = bili.fields.find((f) => f.key === 'cookie')!
    expect(field.type).toBe('secret')
    expect(field.required).toBe(true)
  })

  it('CSRF 也算密钥', () => {
    expect(isSensitiveField(bili.fields.find((f) => f.key === 'csrf')!)).toBe(true)
  })

  it('UID 标成敏感', () => {
    expect(isSensitiveField(bili.fields.find((f) => f.key === 'uid')!)).toBe(true)
  })

  it('没有任何字段落明文', () => {
    const { plain } = splitForStorage(bili, {
      cookie: 'SESSDATA=abc',
      csrf: 'xyz',
      uid: '12345'
    })
    expect(plain).toEqual({})
  })

  it('Cookie 不会出现在日志里', () => {
    const text = JSON.stringify(
      redactValues(bili, { cookie: 'SESSDATA=very-secret', uid: '12345' })
    )
    expect(text).not.toContain('SESSDATA')
    expect(text).not.toContain('12345')
  })
})

describe('游戏账号表', () => {
  it('账号、密码、设备标识都算隐私', () => {
    for (const key of ['account', 'password', 'deviceId']) {
      expect(isSensitiveField(game.fields.find((f) => f.key === key)!), key).toBe(true)
    }
  })

  it('区服名不涉及隐私', () => {
    expect(isSensitiveField(game.fields.find((f) => f.key === 'server')!)).toBe(false)
  })

  it('只有区服会进普通配置', () => {
    const { secrets, plain } = splitForStorage(game, {
      account: '13800000000',
      password: 'p',
      deviceId: 'dev-1',
      server: '官服'
    })
    expect(plain).toEqual({ server: '官服' })
    expect(Object.keys(secrets).sort()).toEqual(['account', 'deviceId', 'password'])
  })
})

describe('个人信息', () => {
  it('六个字段都在', () => {
    expect(PERSONAL_FIELDS.map((f) => f.key)).toEqual([
      'realName',
      'email',
      'phone',
      'address',
      'birthday',
      'idNumber'
    ])
  })

  it('全部进加密仓库，明文那半是空的', () => {
    const split = splitPersonal({
      realName: '张三',
      email: 'a@b.com',
      phone: '13800000000',
      address: '某路 1 号',
      birthday: '2004-03-23',
      idNumber: '110101199001011234'
    })
    expect(Object.keys(split.secrets)).toHaveLength(6)
    expect(split.plain).toEqual({})
  })

  it('没填的字段不出现', () => {
    expect(splitPersonal({ realName: '张三' }).secrets).toEqual({ realName: '张三' })
  })

  it('空白值被忽略', () => {
    expect(splitPersonal({ realName: '   ', email: '' }).secrets).toEqual({})
  })

  it('值写进去前 trim', () => {
    expect(splitPersonal({ realName: '  张三  ' }).secrets.realName).toBe('张三')
  })
})

describe('个人信息脱敏', () => {
  it('邮箱保留首字母和域名', () => {
    expect(redactPersonal({ email: 'zhangsan@example.com' }).email).toBe('z***@example.com')
  })

  it('电话保留前三后四', () => {
    expect(redactPersonal({ phone: '13800001234' }).phone).toBe('138****1234')
  })

  it('真名整段打码', () => {
    expect(redactPersonal({ realName: '张三' }).realName).toBe('********')
  })

  it('证件号整段打码', () => {
    expect(redactPersonal({ idNumber: '110101199001011234' }).idNumber).toBe('********')
  })

  it('地址整段打码', () => {
    expect(redactPersonal({ address: '某路 1 号' }).address).toBe('********')
  })

  it('脱敏后的文本不含原始内容', () => {
    const text = JSON.stringify(
      redactPersonal({ realName: '张三', address: '某路 1 号', idNumber: '110101199001011234' })
    )
    expect(text).not.toContain('张三')
    expect(text).not.toContain('某路')
    expect(text).not.toContain('110101')
  })
})

describe('个人信息写入', () => {
  it('逐项写进 profile 目录', async () => {
    const { writer, written } = fakeWriter()
    await persistPersonal(writer, { realName: '张三', email: 'a@b.com' })
    expect(written.map((w) => w.field).sort()).toEqual(['email', 'realName'])
    expect(written.every((w) => w.scope === PERSONAL_SCOPE)).toBe(true)
  })

  it('目录名不和外部服务混用', () => {
    expect(PERSONAL_SCOPE).toBe('profile')
  })

  it('不传清除列表时不清任何东西', async () => {
    const { writer, cleared } = fakeWriter()
    await persistPersonal(writer, { realName: '张三' })
    expect(cleared).toEqual([])
  })

  it('显式清除时才删', async () => {
    const { writer, cleared } = fakeWriter()
    const result = await persistPersonal(writer, {}, ['phone'])
    expect(result.cleared).toEqual(['phone'])
    expect(cleared).toEqual([{ scope: 'profile', field: 'phone' }])
  })

  it('清除列表里的非字段名被忽略', async () => {
    const { writer, cleared } = fakeWriter()
    const result = await persistPersonal(writer, {}, ['notAField'])
    expect(result.cleared).toEqual([])
    expect(cleared).toEqual([])
  })
})

describe('个人信息校验', () => {
  it('正常值通过', () => {
    expect(
      validatePersonal({ email: 'a@b.com', phone: '13800001234', birthday: '2004-03-23' })
    ).toEqual([])
  })

  it('邮箱格式不对被指出', () => {
    expect(validatePersonal({ email: 'nope' })).toHaveLength(1)
  })

  it('电话带空格或横线也能过', () => {
    expect(validatePersonal({ phone: '138-0000-1234' })).toEqual([])
  })

  it('生日格式不对被指出', () => {
    expect(validatePersonal({ birthday: '2004/03/23' })).toHaveLength(1)
  })

  it('全空不报错', () => {
    expect(validatePersonal({})).toEqual([])
  })
})
