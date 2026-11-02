/**
 * LLM API Key 的 Vault 落点。
 *
 * 只允许存在 VaultStore 的加密文件里；禁止进 settings.json、环境变量、
 * 命令行参数。旧版明文字段由 migrateLegacyLlmKey 迁移，调用方拿到
 * scrubbedField 后必须从配置里删除并保存。
 */

import { ErrorCode, PetError } from '@pet/shared'
import type { AuditLog } from './audit/auditLog.js'
import type { VaultLike } from './store/keyRingVaultStore.js'

export const LLM_API_KEY_FIELD = 'llmApiKey'

export interface LlmSecretStore {
  getApiKey(): Promise<string | null>
  setApiKey(key: string): Promise<void>
  clearApiKey(): Promise<void>
}

/** 明文只在这一层短暂出现，调用方不得回显、记日志或放入剪贴板。 */
export class VaultLlmSecretStore implements LlmSecretStore {
  constructor(
    private readonly vault: VaultLike,
    private readonly audit?: AuditLog
  ) {}

  async getApiKey(): Promise<string | null> {
    const data = await this.vault.load<Record<string, unknown>>()
    const value = data?.[LLM_API_KEY_FIELD]

    return typeof value === 'string' && value.length > 0 ? value : null
  }

  async setApiKey(key: string): Promise<void> {
    if (typeof key !== 'string' || key.trim().length === 0) {
      throw new PetError(ErrorCode.INVALID_ARGUMENT, 'API Key 不能为空')
    }

    const data = (await this.vault.load<Record<string, unknown>>()) ?? {}
    await this.vault.save({ ...data, [LLM_API_KEY_FIELD]: key.trim() })
    await this.audit?.append('llm_key_stored', {
      source: 'user',
      note: 'API Key 已写入 Vault'
    })
  }

  async clearApiKey(): Promise<void> {
    const data = await this.vault.load<Record<string, unknown>>()
    if (data === null || !(LLM_API_KEY_FIELD in data)) return

    const next = { ...data }
    delete next[LLM_API_KEY_FIELD]
    await this.vault.save(next)
    await this.audit?.append('llm_key_cleared', {
      source: 'user',
      note: 'API Key 已从 Vault 移除'
    })
  }
}

export interface LegacyKeyMigrationResult {
  readonly migrated: boolean
  /** 调用方需要从旧配置里删除的字段；null 表示没有可迁移的明文。 */
  readonly scrubbedField: string | null
}

/** 纯函数：返回删掉旧明文字段的配置副本，不改入参。 */
export function scrubLegacyLlmKey(
  settings: Readonly<Record<string, unknown>>
): Record<string, unknown> {
  const next = { ...settings }
  delete next[LLM_API_KEY_FIELD]
  return next
}

/**
 * 把旧配置里的明文 Key 迁进 Vault，并返回待擦除字段。
 * 审计只记事件与来源，不记 Key 本身。
 */
export async function migrateLegacyLlmKey(
  legacy: Readonly<Record<string, unknown>>,
  store: LlmSecretStore,
  audit?: AuditLog
): Promise<LegacyKeyMigrationResult> {
  const raw = legacy[LLM_API_KEY_FIELD]

  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return { migrated: false, scrubbedField: null }
  }

  await store.setApiKey(raw)
  await audit?.append('llm_key_migrated', {
    source: 'system',
    note: '旧明文 API Key 已迁入 Vault，调用方必须从配置中擦除该字段'
  })

  return { migrated: true, scrubbedField: LLM_API_KEY_FIELD }
}
