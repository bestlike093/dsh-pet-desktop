import type { CryptoSuiteId } from '@pet/shared'

/** 单个密钥版本。keyId 写进线格式，epoch 用于轮换判定。 */
export interface VaultKey {
  readonly keyId: number
  readonly epoch: number
  readonly key: Uint8Array
}

/** 密钥环：VaultClient 只通过它取密钥，不直接碰存储。 */
export interface KeyRing {
  readonly suite: CryptoSuiteId
  current(): VaultKey
  byId(keyId: number): VaultKey | undefined
  /** Ed25519 签名密钥对，用于产出 Sealed.sig */
  signer(): Promise<CryptoKeyPair>
  /** base64url(raw 32B Ed25519 公钥) */
  senderPub(): Promise<string>
  rotate(): Promise<void>
  destroy(): void
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length)
  globalThis.crypto.getRandomValues(bytes)
  return bytes
}

export function toBase64Url(bytes: Uint8Array): string {
  let bin = ''
  for (const byte of bytes) bin += String.fromCharCode(byte)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * 进程内临时密钥环：S1 第一刀用，密钥随实例销毁。
 * 落盘密钥后端在 S1 第 6 步接，届时只换这个实现，VaultClient 不动。
 */
export function createEphemeralKeyRing(suite: CryptoSuiteId = 'CS1'): KeyRing {
  const keys = new Map<number, VaultKey>()
  let current: VaultKey = { keyId: 1, epoch: 0, key: randomBytes(32) }
  keys.set(current.keyId, current)
  let signerPair: CryptoKeyPair | null = null

  const ensureSigner = async (): Promise<CryptoKeyPair> => {
    if (signerPair === null) {
      signerPair = (await globalThis.crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
        'sign',
        'verify'
      ])) as CryptoKeyPair
    }
    return signerPair
  }

  return {
    suite,
    current: () => current,
    byId: (keyId) => keys.get(keyId),
    signer: ensureSigner,
    async senderPub() {
      const pair = await ensureSigner()
      const raw = await globalThis.crypto.subtle.exportKey('raw', pair.publicKey)
      return toBase64Url(new Uint8Array(raw))
    },
    async rotate() {
      const next: VaultKey = {
        keyId: current.keyId + 1,
        epoch: current.epoch + 1,
        key: randomBytes(32)
      }
      keys.set(next.keyId, next)
      current = next
    },
    destroy() {
      for (const entry of keys.values()) entry.key.fill(0)
      keys.clear()
    }
  }
}
