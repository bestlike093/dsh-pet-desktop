/**
 * 同步包的字段级加密。
 *
 * 同步目录可能是共享盘，写出去的内容会离开本机。仅靠「不同步」不能解决
 * 换机后人格提示全丢的问题，所以给需要跨机保留的敏感字段单独加一层：
 * 用用户在两台机器上分别输入的同步口令派生密钥，同步包里只留密文。
 *
 * 口令不进 settings.json，只存加密仓库；换机后重新输入即可解开旧包。
 * 口令丢了旧包就真的解不开了，这一点由调用方明确告知，不做静默降级。
 */

import { createCipheriv, createDecipheriv, pbkdf2, randomBytes } from 'node:crypto'
import { promisify } from 'node:util'

const pbkdf2Async = promisify(pbkdf2)

export const SYNC_SECRET_SERVICE = 'sync'
export const SYNC_SECRET_FIELD = 'passphrase'

const KDF = 'pbkdf2-sha256'
const ITERATIONS = 210_000
const KEY_BYTES = 32
const SALT_BYTES = 16
const IV_BYTES = 12
const ENVELOPE_VERSION = 1

/** 信封形状固定，认出不是自家格式就直接拒绝，避免把别的对象当密文解。 */
export function isEncryptedEnvelope(value) {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    value.__encSync === ENVELOPE_VERSION &&
    typeof value.data === 'string'
  )
}

async function deriveKey(passphrase, salt, iterations) {
  return await pbkdf2Async(passphrase, salt, iterations, KEY_BYTES, 'sha256')
}

export async function encryptForSync(plain, passphrase) {
  if (typeof plain !== 'string' || plain.length === 0) {
    throw new Error('同步加密只接受非空字符串')
  }
  if (typeof passphrase !== 'string' || passphrase.length === 0) {
    throw new Error('同步口令为空，拒绝加密')
  }

  const salt = randomBytes(SALT_BYTES)
  const iv = randomBytes(IV_BYTES)
  const key = await deriveKey(passphrase, salt, ITERATIONS)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])

  return {
    __encSync: ENVELOPE_VERSION,
    kdf: KDF,
    iterations: ITERATIONS,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64')
  }
}

export async function decryptFromSync(envelope, passphrase) {
  if (!isEncryptedEnvelope(envelope)) throw new Error('不是同步加密信封')
  if (typeof passphrase !== 'string' || passphrase.length === 0) {
    throw new Error('同步口令为空，无法解密')
  }
  if (envelope.kdf !== KDF) throw new Error(`不支持的 KDF：${String(envelope.kdf)}`)

  const iterations = Number(envelope.iterations)
  if (!Number.isInteger(iterations) || iterations < 100_000) {
    throw new Error('迭代次数过低，拒绝解密')
  }

  const key = await deriveKey(passphrase, Buffer.from(envelope.salt, 'base64'), iterations)
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'))
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'))

  // GCM 校验失败会在这里抛错：口令错、包被改过、字段被截断，都走同一条路径。
  return Buffer.concat([
    decipher.update(Buffer.from(envelope.data, 'base64')),
    decipher.final()
  ]).toString('utf8')
}
