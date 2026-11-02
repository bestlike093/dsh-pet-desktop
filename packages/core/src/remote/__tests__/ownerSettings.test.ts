import { describe, expect, it } from 'vitest'
import {
  OWNER_SETTINGS,
  formatOwnerAllowlist,
  ownerPolicyFromSettings,
  parseOwnerAllowlist,
  validateOwnerAllowlist
} from '../ownerSettings.js'

describe('parseOwnerAllowlist', () => {
  it('支持中英文逗号、分号、空格与换行', () => {
    const raw = '10001, 10002；10003;10004\n10005 10006'
    expect(parseOwnerAllowlist(raw)).toEqual([
      '10001',
      '10002',
      '10003',
      '10004',
      '10005',
      '10006'
    ])
  })

  it('空串得到空列表', () => {
    expect(parseOwnerAllowlist('')).toEqual([])
    expect(parseOwnerAllowlist('   ')).toEqual([])
    expect(parseOwnerAllowlist(',,;;\n')).toEqual([])
  })

  it('容忍首尾与连续分隔符', () => {
    expect(parseOwnerAllowlist(',,10001,,')).toEqual(['10001'])
  })
})

describe('formatOwnerAllowlist', () => {
  it('回填成一行逗号分隔', () => {
    expect(formatOwnerAllowlist(['10001', '10002'])).toBe('10001, 10002')
  })

  it('空列表得到空串', () => {
    expect(formatOwnerAllowlist([])).toBe('')
  })

  it('解析与格式化可以来回跑', () => {
    const ids = ['10001', '10002', '10003']
    expect(parseOwnerAllowlist(formatOwnerAllowlist(ids))).toEqual(ids)
  })
})

describe('validateOwnerAllowlist', () => {
  it('正常号码不报错', () => {
    expect(validateOwnerAllowlist('10001, 10002')).toEqual([])
  })

  it('空值不报错——等于「谁都不是主人」，是合法状态', () => {
    expect(validateOwnerAllowlist('')).toEqual([])
  })

  it('非数字会被指出来', () => {
    const problems = validateOwnerAllowlist('10001, abc, 10002')
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('abc')
  })

  it('重复号码会被指出来', () => {
    const problems = validateOwnerAllowlist('10001, 10001')
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('10001')
  })

  it('非数字与重复可以同时报', () => {
    const problems = validateOwnerAllowlist('abc, abc, 10001, 10001')
    expect(problems).toHaveLength(2)
  })

  it('不拦长度，短号与长号都算合法', () => {
    expect(validateOwnerAllowlist('10000, 123456789012')).toEqual([])
  })
})

describe('ownerPolicyFromSettings', () => {
  it('从设置值构造判定规则', () => {
    const policy = ownerPolicyFromSettings({
      [OWNER_SETTINGS.allowlist]: '10001, 10002',
      [OWNER_SETTINGS.privateOnly]: 'true'
    })

    expect(policy.ownerCount).toBe(2)
    expect(policy.isOwner({ userId: '10001', chatType: 'private' })).toBe(true)
    expect(policy.isOwner({ userId: '10001', chatType: 'group' })).toBe(false)
  })

  it('显式关掉只认私聊后，群聊也认', () => {
    const policy = ownerPolicyFromSettings({
      [OWNER_SETTINGS.allowlist]: '10001',
      [OWNER_SETTINGS.privateOnly]: 'false'
    })

    expect(policy.isOwner({ userId: '10001', chatType: 'group' })).toBe(true)
    expect(policy.requiresPrivateChat).toBe(false)
  })

  it('开关缺失时按安全侧处理：只认私聊', () => {
    const policy = ownerPolicyFromSettings({ [OWNER_SETTINGS.allowlist]: '10001' })

    expect(policy.requiresPrivateChat).toBe(true)
    expect(policy.isOwner({ userId: '10001', chatType: 'group' })).toBe(false)
  })

  it('开关值拼错也按只认私聊处理', () => {
    const policy = ownerPolicyFromSettings({
      [OWNER_SETTINGS.allowlist]: '10001',
      [OWNER_SETTINGS.privateOnly]: 'no'
    })

    expect(policy.requiresPrivateChat).toBe(true)
  })

  it('白名单缺失时谁都不是主人', () => {
    const policy = ownerPolicyFromSettings({})
    expect(policy.ownerCount).toBe(0)
    expect(policy.isOwner({ userId: '10001', chatType: 'private' })).toBe(false)
  })
})
