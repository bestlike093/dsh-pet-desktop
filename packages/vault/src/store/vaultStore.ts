import { ErrorCode, PetError } from '@pet/shared'
import { assertPasswordStrength } from '../crypto/passwordPolicy.js'
import type { CryptoProvider } from '../crypto/provider.js'
import { AesGcmProvider } from '../crypto/provider.js'
import {
  DEFAULT_KDF_ITERATIONS,
  fromBase64,
  openVaultFile,
  parseVaultFile,
  sealVaultFile,
  serializeVaultFile
} from '../file/format.js'

export interface VaultStoragePort {
  read(): Promise<string | null>
  write(text: string): Promise<void>
  /** 实现应写临时文件再 rename；没有时退回 write */
  writeAtomic?(text: string): Promise<void>
}

export interface VaultStoreOptions {
  readonly provider?: CryptoProvider
  readonly now?: () => number
  readonly iterations?: number
}

function randomSalt(): Uint8Array {
  const g = globalThis as unknown as { crypto?: { getRandomValues?: (array: Uint8Array) => Uint8Array } }
  if (g.crypto?.getRandomValues === undefined) {
    throw new PetError(ErrorCode.CRYPTO_SUITE_UNSUPPORTED, '当前运行时没有安全随机源')
  }
  const salt = new Uint8Array(16)
  g.crypto.getRandomValues(salt)
  return salt
}

/**
 * 加密仓库：负责锁定状态、口令校验与原子落盘。
 * 所有失败都收敛成稳定错误码，调用方不需要解析底层异常。
 */
export class VaultStore {
  private readonly storage: VaultStoragePort
  private readonly provider: CryptoProvider
  private readonly now: () => number
  private readonly iterations: number
  private key: Uint8Array | null = null
  private salt: Uint8Array | null = null

  constructor(storage: VaultStoragePort, options: VaultStoreOptions = {}) {
    this.storage = storage
    this.provider = options.provider ?? new AesGcmProvider()
    this.now = options.now ?? Date.now
    this.iterations = options.iterations ?? DEFAULT_KDF_ITERATIONS
  }

  get isLocked(): boolean {
    return this.key === null
  }

  /** 首次没有文件时生成盐；有文件时用文件里的盐派生，顺带验证口令。 */
  async unlock(password: string): Promise<void> {
    if (typeof password !== 'string' || password.length === 0) {
      throw new PetError(ErrorCode.INVALID_ARGUMENT, '口令不能为空')
    }

    const text = await this.storage.read()
    if (text === null || text.trim() === '') {
      // 新库：第一次落盘之前必须够硬。已有仓库不卡强度，
      // 否则一次策略升级就会把原来的使用者锁在门外。
      assertPasswordStrength(password)
      this.salt = randomSalt()
      this.key = await this.provider.deriveKey(password, this.salt)
      return
    }

    const file = parseVaultFile(text)
    const salt = fromBase64(file.kdf.salt)
    const key = await this.provider.deriveKey(password, salt)
    try {
      await openVaultFile(this.provider, key, file)
    } catch (error) {
      throw new PetError(ErrorCode.INVALID_ARGUMENT, '口令错误或仓库已损坏', { cause: error })
    }

    this.salt = salt
    this.key = key
  }

  lock(): void {
    this.key = null
  }

  async save(data: unknown): Promise<void> {
    if (this.key === null || this.salt === null) {
      throw new PetError(ErrorCode.VAULT_LOCKED, '仓库未解锁')
    }

    const plaintext = new TextEncoder().encode(JSON.stringify(data))
    const file = await sealVaultFile(this.provider, this.key, plaintext, {
      salt: this.salt,
      iterations: this.iterations,
      updatedAt: this.now()
    })
    const text = serializeVaultFile(file)

    if (this.storage.writeAtomic !== undefined) {
      await this.storage.writeAtomic(text)
    } else {
      await this.storage.write(text)
    }
  }

  async load<T = unknown>(): Promise<T | null> {
    if (this.key === null) {
      throw new PetError(ErrorCode.VAULT_LOCKED, '仓库未解锁')
    }

    const text = await this.storage.read()
    if (text === null || text.trim() === '') return null

    const file = parseVaultFile(text)
    const plaintext = await openVaultFile(this.provider, this.key, file)
    try {
      return JSON.parse(new TextDecoder().decode(plaintext)) as T
    } catch (error) {
      throw new PetError(ErrorCode.VAULT_TAMPERED, '仓库明文不是合法 JSON', { cause: error })
    }
  }
}

/** 内存存储：测试与无宿主环境的默认实现。 */
export class MemoryVaultStorage implements VaultStoragePort {
  private text: string | null = null

  async read(): Promise<string | null> {
    return this.text
  }

  async write(text: string): Promise<void> {
    this.text = text
  }

  async writeAtomic(text: string): Promise<void> {
    this.text = text
  }

  raw(): string | null {
    return this.text
  }

  tamper(next: string): void {
    this.text = next
  }
}
