import { describe, expect, it } from 'vitest'
import type { AuditLog } from '../audit/auditLog.js'
import { LLM_API_KEY_FIELD, VaultLlmSecretStore, migrateLegacyLlmKey, scrubLegacyLlmKey } from '../llmSecretStore.js'
import { MemoryVaultStorage, VaultStore } from '../store/vaultStore.js'

function fakeAudit(): { audit: AuditLog; events: Array<{ event: string; details?: unknown }> } {
  const events: Array<{ event: string; details?: unknown }> = []
  const audit = {
    append: async (event: string, details?: unknown) => {
      events.push({ event, details })
      return {} as never
    },
    verify: async () => undefined,
    entries: async () => []
  } as unknown as AuditLog
  return { audit, events }
}

async function makeStore(audit?: AuditLog): Promise<{
  storage: MemoryVaultStorage
  store: VaultLlmSecretStore
}> {
  const storage = new MemoryVaultStorage()
  const vault = new VaultStore(storage, { iterations: 1000 })
  await vault.unlock('test-password')
  return { storage, store: new VaultLlmSecretStore(vault, audit) }
}

describe('LLM API Key 进 Vault（S5）', () => {
  it('写入后可取回，密文文件不含明文', async () => {
    const { storage, store } = await makeStore()

    await store.setApiKey('sk-test-123')

    expect(await store.getApiKey()).toBe('sk-test-123')
    expect(storage.raw()).not.toContain('sk-test-123')
  })

  it('clearApiKey 后返回 null，并写审计', async () => {
    const { audit, events } = fakeAudit()
    const { store } = await makeStore(audit)

    await store.setApiKey('sk-test-123')
    await store.clearApiKey()

    expect(await store.getApiKey()).toBeNull()
    expect(events.map((item) => item.event)).toContain('llm_key_cleared')
  })

  it('旧明文迁入 Vault，并返回需要擦除的字段名', async () => {
    const { store } = await makeStore()

    const result = await migrateLegacyLlmKey({ [LLM_API_KEY_FIELD]: 'sk-legacy-456' }, store)

    expect(result.migrated).toBe(true)
    expect(result.scrubbedField).toBe(LLM_API_KEY_FIELD)
    expect(await store.getApiKey()).toBe('sk-legacy-456')
  })

  it('迁移审计只记事件与来源，不含明文', async () => {
    const { audit, events } = fakeAudit()
    const { store } = await makeStore(audit)

    await migrateLegacyLlmKey({ [LLM_API_KEY_FIELD]: 'sk-legacy-456' }, store, audit)

    const serialized = JSON.stringify(events)
    expect(serialized).toContain('llm_key_migrated')
    expect(serialized).not.toContain('sk-legacy-456')
  })

  it('没有旧明文时不迁移、不返回待擦除字段', async () => {
    const { store } = await makeStore()

    const result = await migrateLegacyLlmKey({ nickname: '小鹿' }, store)

    expect(result.migrated).toBe(false)
    expect(result.scrubbedField).toBeNull()
  })

  it('迁移后擦除旧字段：新配置不含 llmApiKey，其余字段保留', async () => {
    const { store } = await makeStore()
    const legacy = { [LLM_API_KEY_FIELD]: 'sk-legacy-456', nickname: '小鹿' }

    const result = await migrateLegacyLlmKey(legacy, store)
    const scrubbed = scrubLegacyLlmKey(legacy)

    expect(result.scrubbedField).toBe(LLM_API_KEY_FIELD)
    expect(LLM_API_KEY_FIELD in scrubbed).toBe(false)
    expect(scrubbed.nickname).toBe('小鹿')
    expect(await store.getApiKey()).toBe('sk-legacy-456')
  })

  it('空 key 明确抛错，不写入空值', async () => {
    const { store } = await makeStore()

    await expect(store.setApiKey('   ')).rejects.toThrow()
    expect(await store.getApiKey()).toBeNull()
  })
})
