import { ErrorCode, PetError } from '@pet/shared'

export interface SealedBox {
  /** 套件编号，解密时据此选 provider，不信任数据自报 */
  readonly suite: string
  /** 12/24 字节随机 nonce，base64 */
  readonly nonce: string
  /** 密文 + tag，base64 */
  readonly ciphertext: string
}

/** 加密套件契约。切套件只换实现，不动 vault 上层。 */
export interface CryptoProvider {
  readonly suite: string
  /** 运行时可用性探测：后端缺失时返回 false，由调用方降级 */
  available(): Promise<boolean>
  deriveKey(password: string, salt: Uint8Array): Promise<Uint8Array>
  seal(key: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): Promise<SealedBox>
  open(key: Uint8Array, box: SealedBox, aad: Uint8Array): Promise<Uint8Array>
}

export const SUITE_CS1 = 'CS1' as const
export const SUITE_CS2 = 'CS2' as const

type WebCryptoLike = { subtle?: SubtleCrypto; getRandomValues?: (a: Uint8Array) => Uint8Array }

function webcrypto(): WebCryptoLike {
  const g = globalThis as unknown as { crypto?: WebCryptoLike }
  if (g.crypto === undefined) {
    throw new PetError(ErrorCode.CRYPTO_SUITE_UNSUPPORTED, '当前运行时没有 WebCrypto')
  }
  return g.crypto
}

/**
 * TS 5.7 起 WebCrypto 的 BufferSource 只接受 ArrayBuffer 背后的视图，
 * 而 Uint8Array 默认泛型是 ArrayBufferLike（可能是 SharedArrayBuffer）。
 * 统一复制进新的 ArrayBuffer，既满足类型也避免调用方共享内存被篡改。
 */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(copy).set(bytes)
  return copy
}

function toBase64(bytes: Uint8Array): string {
  let bin = ''
  for (const byte of bytes) bin += String.fromCharCode(byte)
  return btoa(bin)
}

function fromBase64(value: string): Uint8Array {
  const bin = atob(value)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** 密钥缓存按内容比较；调用方每次都可能传一份新的 Uint8Array。 */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false
  }
  return true
}

/** CS1：AES-256-GCM，纯 WebCrypto，零依赖。 */
export class AesGcmProvider implements CryptoProvider {
  readonly suite = SUITE_CS1
  private cached: CryptoKey | null = null
  private cachedRaw: Uint8Array | null = null

  async available(): Promise<boolean> {
    try {
      return webcrypto().subtle !== undefined
    } catch {
      return false
    }
  }

  async deriveKey(password: string, salt: Uint8Array): Promise<Uint8Array> {
    const crypto = webcrypto()
    if (crypto.subtle === undefined) {
      throw new PetError(ErrorCode.CRYPTO_SUITE_UNSUPPORTED, 'WebCrypto subtle 不可用')
    }
    const base = await crypto.subtle.importKey(
      'raw',
      toArrayBuffer(new TextEncoder().encode(password)),
      'PBKDF2',
      false,
      ['deriveBits']
    )
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt: toArrayBuffer(salt), iterations: 600_000, hash: 'SHA-256' },
      base,
      256
    )
    return new Uint8Array(bits)
  }

  private async key(raw: Uint8Array): Promise<CryptoKey> {
    if (this.cached !== null && this.cachedRaw !== null && bytesEqual(this.cachedRaw, raw)) {
      return this.cached
    }
    const subtle = webcrypto().subtle
    if (subtle === undefined) {
      throw new PetError(ErrorCode.CRYPTO_SUITE_UNSUPPORTED, 'WebCrypto subtle 不可用')
    }
    const k = await subtle.importKey('raw', toArrayBuffer(raw), 'AES-GCM', false, ['encrypt', 'decrypt'])
    this.cached = k
    this.cachedRaw = raw.slice()
    return k
  }

  async seal(key: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): Promise<SealedBox> {
    const crypto = webcrypto()
    const subtle = crypto.subtle
    if (subtle === undefined || crypto.getRandomValues === undefined) {
      throw new PetError(ErrorCode.CRYPTO_SUITE_UNSUPPORTED, 'WebCrypto 不可用')
    }
    const nonce = new Uint8Array(12)
    crypto.getRandomValues(nonce)
    const cipher = await subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: toArrayBuffer(nonce),
        additionalData: toArrayBuffer(aad),
        tagLength: 128
      },
      await this.key(key),
      toArrayBuffer(plaintext)
    )
    return { suite: this.suite, nonce: toBase64(nonce), ciphertext: toBase64(new Uint8Array(cipher)) }
  }

  async open(key: Uint8Array, box: SealedBox, aad: Uint8Array): Promise<Uint8Array> {
    if (box.suite !== this.suite) {
      throw new PetError(ErrorCode.CRYPTO_SUITE_UNSUPPORTED, '套件不匹配：' + box.suite)
    }
    const subtle = webcrypto().subtle
    if (subtle === undefined) {
      throw new PetError(ErrorCode.CRYPTO_SUITE_UNSUPPORTED, 'WebCrypto subtle 不可用')
    }
    const plain = await subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: toArrayBuffer(fromBase64(box.nonce)),
        additionalData: toArrayBuffer(aad),
        tagLength: 128
      },
      await this.key(key),
      toArrayBuffer(fromBase64(box.ciphertext))
    )
    return new Uint8Array(plain)
  }
}
