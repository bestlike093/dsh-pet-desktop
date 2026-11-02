import { describe, expect, it } from 'vitest'
import {
  MIN_PASSWORD_LENGTH,
  assertPasswordStrength,
  evaluatePassword
} from '../crypto/passwordPolicy.js'

describe('口令强度（S-7）', () => {
  it('短口令一律不过，并说明长度', () => {
    const result = evaluatePassword('a')
    expect(result.ok).toBe(false)
    expect(result.reasons.join('')).toContain(String(MIN_PASSWORD_LENGTH))
  })

  it('空口令直接拒', () => {
    expect(evaluatePassword('').ok).toBe(false)
  })

  it('八位纯数字不过：只有一类字符', () => {
    expect(evaluatePassword('12345678').ok).toBe(false)
  })

  it('八位纯小写字母不过', () => {
    expect(evaluatePassword('abcdefgh').ok).toBe(false)
  })

  it('同一字符重复不过', () => {
    expect(evaluatePassword('aaaaaaaa').ok).toBe(false)
    expect(evaluatePassword('11111111').ok).toBe(false)
  })

  it('常见弱口令即使够长也不收', () => {
    expect(evaluatePassword('password123').ok).toBe(false)
    expect(evaluatePassword('Passw0rd').ok).toBe(false)
  })

  it('大小写混用且够长可以通过', () => {
    const result = evaluatePassword('SakuraPink')
    expect(result.ok).toBe(true)
    expect(result.reasons).toEqual([])
  })

  it('数字加符号也能通过', () => {
    expect(evaluatePassword('240323!!').ok).toBe(true)
  })

  it('断言函数对弱口令抛 INVALID_ARGUMENT', () => {
    expect(() => assertPasswordStrength('a')).toThrowError(/口令强度不足/)
  })

  it('断言函数对强口令不抛', () => {
    expect(() => assertPasswordStrength('Cyrene2026')).not.toThrow()
  })
})
