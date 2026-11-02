import { readFileSync } from 'node:fs'
import { createCipheriv, createDecipheriv } from 'node:crypto'
import type { CipherGCM, DecipherGCM } from 'node:crypto'
import { gcm } from '@noble/ciphers/aes.js'
import { describe, expect, it } from 'vitest'

type WycheproofResult = 'valid' | 'invalid' | 'acceptable'

interface WycheproofTest {
  tcId: number
  comment: string
  key: string
  iv: string
  aad: string
  msg: string
  ct: string
  tag: string
  result: WycheproofResult
}

interface WycheproofGroup {
  ivSize: number
  keySize: number
  tagSize: number
  tests: WycheproofTest[]
}

interface WycheproofFixture {
  numberOfTests: number
  testGroups: WycheproofGroup[]
}

interface SkipRecord {
  tcId: number
  nonceBytes: number
  reason: string
}

const fixture = JSON.parse(
  readFileSync(
    new URL('../../../../test/fixtures/wycheproof/aes_gcm_test.json', import.meta.url),
    'utf8'
  )
) as WycheproofFixture

const hex = (value: string): Uint8Array => new Uint8Array(Buffer.from(value, 'hex'))

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

function nodeCipherName(keySize: number): string {
  if (keySize === 128) return 'aes-128-gcm'
  if (keySize === 192) return 'aes-192-gcm'
  if (keySize === 256) return 'aes-256-gcm'
  throw new Error('unsupported keySize: ' + keySize)
}

function nodeDecrypt(
  key: Uint8Array,
  iv: Uint8Array,
  aad: Uint8Array,
  ciphertext: Uint8Array,
  tag: Uint8Array
): Uint8Array {
  const decipher = createDecipheriv(nodeCipherName(key.length * 8), key, iv) as DecipherGCM
  decipher.setAuthTag(tag)
  if (aad.length > 0) decipher.setAAD(aad, { plaintextLength: ciphertext.length })
  return new Uint8Array(Buffer.concat([decipher.update(ciphertext), decipher.final()]))
}

function nodeEncrypt(
  key: Uint8Array,
  iv: Uint8Array,
  aad: Uint8Array,
  plaintext: Uint8Array
): Uint8Array {
  const cipher = createCipheriv(nodeCipherName(key.length * 8), key, iv) as CipherGCM
  if (aad.length > 0) cipher.setAAD(aad, { plaintextLength: plaintext.length })
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return new Uint8Array(Buffer.concat([body, cipher.getAuthTag()]))
}

function nobleDecrypt(
  key: Uint8Array,
  iv: Uint8Array,
  aad: Uint8Array,
  ciphertext: Uint8Array,
  tag: Uint8Array
): Uint8Array {
  return new Uint8Array(gcm(key, iv, aad).decrypt(concat(ciphertext, tag)))
}

function nobleEncrypt(
  key: Uint8Array,
  iv: Uint8Array,
  aad: Uint8Array,
  plaintext: Uint8Array
): Uint8Array {
  return new Uint8Array(gcm(key, iv, aad).encrypt(plaintext))
}

/**
 * 两条实现各自收窄了 GCM 的 IV 长度（SP 800-38D 允许实现这样做）：
 * - Node/OpenSSL 实测支持 1..128 字节，0 与 >128 字节直接拒绝；
 * - @noble/ciphers 2.4.0 明确要求 nonce >= 8 字节。
 * 生产路径 CS1 固定 12 字节，落在交集内。
 */
const NODE_IV_SUPPORTED = (length: number): boolean => length >= 1 && length <= 128
const NOBLE_IV_SUPPORTED = (length: number): boolean => length >= 8

const coverage = { total: 0, both: 0, nodeOnly: 0, nobleOnly: 0, neither: 0 }
const skipped: SkipRecord[] = []

/** 共同支持范围内：两条实现都必须通过；任一侧失败即判该向量失败。 */
function assertVector(test: WycheproofTest): void {
  const key = hex(test.key)
  const iv = hex(test.iv)
  const aad = hex(test.aad)
  const msg = hex(test.msg)
  const ct = hex(test.ct)
  const tag = hex(test.tag)
  const label = `tcId=${test.tcId} ${test.comment}`.trim()

  if (test.result === 'valid') {
    expect(nodeDecrypt(key, iv, aad, ct, tag), `node 解密 ${label}`).toEqual(msg)
    expect(nobleDecrypt(key, iv, aad, ct, tag), `noble 解密 ${label}`).toEqual(msg)
    expect(nodeEncrypt(key, iv, aad, msg), `node 加密 ${label}`).toEqual(concat(ct, tag))
    expect(nobleEncrypt(key, iv, aad, msg), `noble 加密 ${label}`).toEqual(concat(ct, tag))
  } else {
    expect(() => nodeDecrypt(key, iv, aad, ct, tag), `node 应拒绝 ${label}`).toThrow()
    expect(() => nobleDecrypt(key, iv, aad, ct, tag), `noble 应拒绝 ${label}`).toThrow()
  }
}

describe('Wycheproof AES-GCM（node:crypto + @noble/ciphers 双实现）', () => {
  it('向量总量与分组数一致', () => {
    expect(fixture.numberOfTests).toBe(316)
    expect(fixture.testGroups.reduce((n, g) => n + g.tests.length, 0)).toBe(316)
  })

  fixture.testGroups.forEach((group, groupIndex) => {
    it(`组 ${groupIndex}：key=${group.keySize} iv=${group.ivSize} tag=${group.tagSize}`, () => {
      for (const test of group.tests) {
        const ivLength = hex(test.iv).length
        coverage.total += 1
        const nodeSupported = NODE_IV_SUPPORTED(ivLength)
        const nobleSupported = NOBLE_IV_SUPPORTED(ivLength)

        if (nodeSupported && nobleSupported) {
          coverage.both += 1
          assertVector(test)
          continue
        }

        if (nodeSupported) coverage.nodeOnly += 1
        else if (nobleSupported) coverage.nobleOnly += 1
        else coverage.neither += 1

        const reasons: string[] = []
        if (!nodeSupported) reasons.push(`node 仅支持 1..128B，当前 ${ivLength}B`)
        if (!nobleSupported) reasons.push(`noble 要求 >=8B，当前 ${ivLength}B`)
        skipped.push({ tcId: test.tcId, nonceBytes: ivLength, reason: reasons.join('；') })

        // 范围外只验证支持的一侧；不支持的一侧在 skip 记录里写明原因。
        const key = hex(test.key)
        const iv = hex(test.iv)
        const aad = hex(test.aad)
        const msg = hex(test.msg)
        const ct = hex(test.ct)
        const tag = hex(test.tag)
        const label = `tcId=${test.tcId} ${test.comment}`.trim()

        if (test.result === 'valid') {
          if (nodeSupported) {
            expect(nodeDecrypt(key, iv, aad, ct, tag), `node 解密 ${label}`).toEqual(msg)
            expect(nodeEncrypt(key, iv, aad, msg), `node 加密 ${label}`).toEqual(concat(ct, tag))
          }
          if (nobleSupported) {
            expect(nobleDecrypt(key, iv, aad, ct, tag), `noble 解密 ${label}`).toEqual(msg)
            expect(nobleEncrypt(key, iv, aad, msg), `noble 加密 ${label}`).toEqual(concat(ct, tag))
          }
        } else {
          if (nodeSupported) {
            expect(() => nodeDecrypt(key, iv, aad, ct, tag), `node 应拒绝 ${label}`).toThrow()
          }
          if (nobleSupported) {
            expect(() => nobleDecrypt(key, iv, aad, ct, tag), `noble 应拒绝 ${label}`).toThrow()
          }
        }
      }
    })
  })

  it('12 字节 nonce（CS1 生产路径）197 条双实现 100% 通过', () => {
    const vectors = fixture.testGroups
      .filter((group) => group.ivSize === 96)
      .flatMap((group) => group.tests)

    expect(vectors).toHaveLength(197)
    for (const test of vectors) assertVector(test)
  })

  it('33 条范围外向量逐条记录原因，禁止静默 skip', () => {
    expect(skipped).toHaveLength(33)
    for (const item of skipped) {
      expect(item.reason.length, `tcId=${item.tcId}`).toBeGreaterThan(0)
      expect(item.reason).toContain('B')
    }
    console.log(
      'Wycheproof 跳过清单：\n' +
        skipped
          .map((item) => `tcId=${item.tcId} nonce=${item.nonceBytes}B ${item.reason}`)
          .join('\n')
    )
  })

  it('覆盖统计：双实现 283 条，范围外 33 条', () => {
    expect(coverage.total).toBe(316)
    expect(coverage.both).toBe(283)
    expect(coverage.nodeOnly).toBe(24)
    expect(coverage.nobleOnly).toBe(3)
    expect(coverage.neither).toBe(6)
  })
})
