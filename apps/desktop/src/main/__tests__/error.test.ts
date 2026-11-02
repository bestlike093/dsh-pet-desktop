import { describe, expect, it } from 'vitest'
import { describeError } from '../error.js'

describe('describeError', () => {
  it('Error 取 message', () => {
    expect(describeError(new Error('boom'))).toBe('boom')
  })

  it('Error 子类同样取 message', () => {
    class PetError extends Error {}
    expect(describeError(new PetError('pet failed'))).toBe('pet failed')
  })

  it('字符串原样返回', () => {
    expect(describeError('plain')).toBe('plain')
  })

  it('数字与布尔转字符串', () => {
    expect(describeError(42)).toBe('42')
    expect(describeError(false)).toBe('false')
  })

  it('null / undefined 不抛', () => {
    expect(describeError(null)).toBe('null')
    expect(describeError(undefined)).toBe('undefined')
  })

  it('普通对象走 String 兜底，不抛', () => {
    expect(describeError({ code: 1 })).toBe('[object Object]')
  })
})
