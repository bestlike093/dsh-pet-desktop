import { describe, expect, it } from 'vitest'
import { ERROR_FIX_HINTS, ErrorCode, assertPersistableCode, fixHintOf, PetError } from '../errors.js'

/** S1 收敛前的 5 个旧码；收敛后只用于反向断言，不得再出现在任何输出里。 */
const LEGACY_CODE_VALUES = [
  'ASSET_INVALID_MIME',
  'ASSET_PATH_ESCAPE',
  'ASSET_TOO_LARGE',
  'MODULE_LOAD_FAILED',
  'MODULE_TIMEOUT'
] as const

describe('ErrorCode 与 fixHint', () => {
  it('NOT_IMPLEMENTED 存在，码表值无重复', () => {
    expect(ErrorCode.NOT_IMPLEMENTED).toBe('NOT_IMPLEMENTED')
    const values = Object.values(ErrorCode)
    expect(new Set(values).size).toBe(values.length)
  })

  it('文档 S0 最小码表 13 码全部可查 fixHint', () => {
    for (const code of [
      ErrorCode.NOT_IMPLEMENTED,
      ErrorCode.SIGNATURE_INVALID,
      ErrorCode.REPLAY_DETECTED,
      ErrorCode.TIMESTAMP_EXPIRED,
      ErrorCode.NONCE_REUSE,
      ErrorCode.KEY_PERMISSION,
      ErrorCode.MIME_MISMATCH,
      ErrorCode.PATH_TRAVERSAL,
      ErrorCode.ZIP_BOMB,
      ErrorCode.QUOTA_EXCEEDED,
      ErrorCode.LOAD_FAILED,
      ErrorCode.LOAD_TIMEOUT,
      ErrorCode.PERMISSION_DENIED
    ]) {
      expect(ERROR_FIX_HINTS[code]).toBeTypeOf('string')
      expect(fixHintOf(code)).not.toBe('')
    }
  })

  it('未收录的码走兜底文案', () => {
    expect(fixHintOf(ErrorCode.UNKNOWN)).toContain('日志')
  })

  it('旧码已从 ErrorCode 中移除', () => {
    for (const legacy of LEGACY_CODE_VALUES) {
      expect(Object.values(ErrorCode)).not.toContain(legacy)
    }
  })

  it('四类持久化输出样例不含旧码', () => {
    const samples: Record<string, string> = {
      diagnostic: JSON.stringify({ code: ErrorCode.MIME_MISMATCH, hint: fixHintOf(ErrorCode.MIME_MISMATCH) }),
      loopback: JSON.stringify({ code: ErrorCode.PATH_TRAVERSAL, seq: 1 }),
      settings: JSON.stringify({ lastError: ErrorCode.QUOTA_EXCEEDED }),
      audit: JSON.stringify({ code: ErrorCode.LOAD_FAILED, stage: 'S1' })
    }
    for (const [kind, payload] of Object.entries(samples)) {
      for (const legacy of LEGACY_CODE_VALUES) {
        expect(payload, `${kind} 不得含旧码 ${legacy}`).not.toContain(legacy)
      }
    }
  })

  it('持久化守卫拒绝码表外的字符串', () => {
    expect(() => assertPersistableCode('NOT_A_REAL_CODE')).toThrow(PetError)

    try {
      assertPersistableCode('NOT_A_REAL_CODE')
      expect.unreachable('未登记码必须抛错')
    } catch (error) {
      expect(error).toBeInstanceOf(PetError)
      expect((error as PetError).code).toBe(ErrorCode.INVALID_ARGUMENT)
    }
  })

  it('持久化守卫放行码表内全部码', () => {
    for (const code of Object.values(ErrorCode)) {
      expect(() => assertPersistableCode(code)).not.toThrow()
    }
  })

  it('PetError 保留 code 与 details', () => {
    const error = new PetError(ErrorCode.NOT_IMPLEMENTED, 'not yet', {
      details: { stage: 'S8' }
    })
    expect(error.code).toBe('NOT_IMPLEMENTED')
    expect(error.details).toEqual({ stage: 'S8' })
    expect(error.toJSON()).toMatchObject({ code: 'NOT_IMPLEMENTED' })
  })
})
