import { DEFAULT_SETTINGS, ErrorCode, PetError, migrateSettings } from '@pet/shared'
import type { SettingsV2 } from '@pet/shared'

/** 存储端口：桌面壳用文件实现，测试用内存实现，core 不直接碰 fs。 */
export interface StoragePort {
  read(key: string): Promise<string | null>
  write(key: string, value: string): Promise<void>
}

export interface SettingsStoreOptions {
  readonly key?: string
  readonly now?: () => number
}

export type SettingsLoadResult =
  | {
      readonly ok: true
      readonly value: SettingsV2
      readonly migrated: boolean
      readonly legacy: Readonly<Record<string, unknown>>
    }
  | { readonly ok: false; readonly error: PetError; readonly value: SettingsV2 }

export type SettingsSaveResult =
  | { readonly ok: true; readonly value: SettingsV2 }
  | { readonly ok: false; readonly error: PetError; readonly value: SettingsV2 }

/**
 * 配置存储。
 * 读：解析失败或迁移失败都保留当前内存值，绝不把坏数据写回；
 * 写：先迁移校验，校验通过才落盘，落盘失败也不改内存。
 */
export class SettingsStore {
  private readonly storage: StoragePort
  private readonly key: string
  private current: SettingsV2 = DEFAULT_SETTINGS
  private loaded = false

  constructor(storage: StoragePort, options: SettingsStoreOptions = {}) {
    this.storage = storage
    this.key = options.key ?? 'settings.v2'
    void options.now
  }

  get(): SettingsV2 {
    return this.current
  }

  get isLoaded(): boolean {
    return this.loaded
  }

  async load(): Promise<SettingsLoadResult> {
    let text: string | null
    try {
      text = await this.storage.read(this.key)
    } catch (error) {
      return {
        ok: false,
        error: new PetError(ErrorCode.UNKNOWN, '读取配置失败', { cause: error }),
        value: this.current
      }
    }

    if (text === null || text.trim() === '') {
      this.loaded = true
      return { ok: true, value: this.current, migrated: false, legacy: {} }
    }

    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch (error) {
      return {
        ok: false,
        error: new PetError(ErrorCode.INVALID_ARGUMENT, '配置文件不是合法 JSON', { cause: error }),
        value: this.current
      }
    }

    const migrated = migrateSettings(raw)
    if (!migrated.ok) {
      return { ok: false, error: migrated.error, value: this.current }
    }

    const wasV1 = typeof (raw as { schemaVersion?: unknown }).schemaVersion !== 'number'
    this.current = migrated.value
    this.loaded = true
    return { ok: true, value: this.current, migrated: wasV1, legacy: migrated.legacy }
  }

  async save(raw: unknown): Promise<SettingsSaveResult> {
    const migrated = migrateSettings(raw)
    if (!migrated.ok) {
      return { ok: false, error: migrated.error, value: this.current }
    }

    try {
      await this.storage.write(this.key, JSON.stringify(migrated.value))
    } catch (error) {
      return {
        ok: false,
        error: new PetError(ErrorCode.UNKNOWN, '写入配置失败', { cause: error }),
        value: this.current
      }
    }

    this.current = migrated.value
    this.loaded = true
    return { ok: true, value: this.current }
  }

  /** 浅合并后走完整校验，避免局部更新绕过 schema。 */
  async update(patch: Partial<SettingsV2>): Promise<SettingsSaveResult> {
    return this.save({ ...this.current, ...patch, schemaVersion: 2 })
  }
}

/** 内存存储：测试与无宿主环境下的默认实现。 */
export class MemoryStorage implements StoragePort {
  private readonly data = new Map<string, string>()

  async read(key: string): Promise<string | null> {
    return this.data.get(key) ?? null
  }

  async write(key: string, value: string): Promise<void> {
    this.data.set(key, value)
  }

  size(): number {
    return this.data.size
  }
}
