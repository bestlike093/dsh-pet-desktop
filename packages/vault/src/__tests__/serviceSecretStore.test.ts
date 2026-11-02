import { describe, expect, it } from 'vitest'
import type { AuditLog } from '../audit/auditLog.js'
import { VaultServiceSecretStore, assertSecretKey, maskSecret } from '../serviceSecretStore.js'
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
  store: VaultServiceSecretStore
}> {
  const storage = new MemoryVaultStorage()
  const vault = new VaultStore(storage, { iterations: 1000 })
  await vault.unlock('test-password')
  return { storage, store: new VaultServiceSecretStore(vault, audit) }
}

describe('服务密钥进 Vault', () => {
  it('写入后可取回', async () => {
    const { store } = await makeStore()
    await store.set('weather', 'sk-weather-123456')
    expect(await store.get('weather')).toBe('sk-weather-123456')
  })

  it('密文文件里不含明文', async () => {
    const { storage, store } = await makeStore()
    await store.set('translate', 'sk-translate-secret')
    expect(storage.raw()).not.toContain('sk-translate-secret')
  })

  it('没配过的服务返回 null', async () => {
    const { store } = await makeStore()
    expect(await store.get('weather')).toBeNull()
  })

  it('空值拒绝写入', async () => {
    const { store } = await makeStore()
    await expect(store.set('weather', '   ')).rejects.toThrow('不能为空')
  })

  it('写入前 trim 掉首尾空白', async () => {
    const { store } = await makeStore()
    await store.set('weather', '  sk-w-1  ')
    expect(await store.get('weather')).toBe('sk-w-1')
  })
})

describe('多服务隔离', () => {
  it('各服务互不覆盖', async () => {
    const { store } = await makeStore()
    await store.set('weather', 'sk-w')
    await store.set('translate', 'sk-t')
    expect(await store.get('weather')).toBe('sk-w')
    expect(await store.get('translate')).toBe('sk-t')
  })

  it('同一服务的不同字段互不覆盖', async () => {
    const { store } = await makeStore()
    await store.set('weather', 'sk-api', 'apiKey')
    await store.set('weather', 'sk-backup', 'backupKey')
    expect(await store.get('weather', 'apiKey')).toBe('sk-api')
    expect(await store.get('weather', 'backupKey')).toBe('sk-backup')
  })

  it('clear 只清指定字段', async () => {
    const { store } = await makeStore()
    await store.set('weather', 'sk-api', 'apiKey')
    await store.set('weather', 'sk-backup', 'backupKey')
    await store.clear('weather', 'apiKey')
    expect(await store.get('weather', 'apiKey')).toBeNull()
    expect(await store.get('weather', 'backupKey')).toBe('sk-backup')
  })

  it('clearService 只清该服务', async () => {
    const { store } = await makeStore()
    await store.set('weather', 'sk-w')
    await store.set('weather', 'sk-w2', 'backupKey')
    await store.set('translate', 'sk-t')

    const removed = await store.clearService('weather')
    expect(removed).toBe(2)
    expect(await store.get('weather')).toBeNull()
    expect(await store.get('translate')).toBe('sk-t')
  })

  it('clearService 对没配过的服务返回 0', async () => {
    const { store } = await makeStore()
    expect(await store.clearService('weather')).toBe(0)
  })
})

describe('listConfigured', () => {
  it('列出已配置的服务', async () => {
    const { store } = await makeStore()
    await store.set('translate', 'sk-t')
    await store.set('weather', 'sk-w')
    expect(await store.listConfigured()).toEqual(['translate', 'weather'])
  })

  it('空仓库返回空数组', async () => {
    const { store } = await makeStore()
    expect(await store.listConfigured()).toEqual([])
  })

  it('清空后不再列出', async () => {
    const { store } = await makeStore()
    await store.set('weather', 'sk-w')
    await store.clearService('weather')
    expect(await store.listConfigured()).toEqual([])
  })
})

describe('掩码', () => {
  it('长密钥保留前三后四', () => {
    expect(maskSecret('sk-abcdefghijklmnop')).toBe('sk-****mnop')
  })

  it('短密钥全掩码', () => {
    expect(maskSecret('short')).toBe('********')
  })

  it('空串返回空串', () => {
    expect(maskSecret('   ')).toBe('')
  })

  it('掩码长度不随原文变化', () => {
    const a = maskSecret('a'.repeat(20))
    const b = maskSecret('a'.repeat(40))
    expect(a.length).toBe(b.length)
  })

  it('getMasked 不返回明文', async () => {
    const { store } = await makeStore()
    await store.set('weather', 'demo-verysecretvalue123')
    const masked = await store.getMasked('weather')
    expect(masked).not.toBeNull()
    expect(masked).not.toContain('verysecret')
  })

  it('未配置时 getMasked 返回 null', async () => {
    const { store } = await makeStore()
    expect(await store.getMasked('weather')).toBeNull()
  })
})

describe('键名校验', () => {
  it('合法 id 通过', () => {
    expect(() => assertSecretKey('weather', 'apiKey')).not.toThrow()
    expect(() => assertSecretKey('exchange-rate', 'apiKey')).not.toThrow()
  })

  it('带点号的 id 被拒，防止越界前缀', () => {
    expect(() => assertSecretKey('weather.other', 'apiKey')).toThrow()
  })

  it('空 id 被拒', () => {
    expect(() => assertSecretKey('', 'apiKey')).toThrow()
  })

  it('数字开头的 id 被拒', () => {
    expect(() => assertSecretKey('1weather', 'apiKey')).toThrow()
  })
})

describe('审计', () => {
  it('写入记事件，但不记值', async () => {
    const { audit, events } = fakeAudit()
    const { store } = await makeStore(audit)

    await store.set('weather', 'sk-secret-value')

    expect(events.map((e) => e.event)).toContain('service_key_stored')
    expect(JSON.stringify(events)).not.toContain('sk-secret-value')
  })

  it('清除记事件，也不记值', async () => {
    const { audit, events } = fakeAudit()
    const { store } = await makeStore(audit)

    await store.set('weather', 'sk-secret-value')
    await store.clear('weather')

    expect(events.map((e) => e.event)).toContain('service_key_cleared')
    expect(JSON.stringify(events)).not.toContain('sk-secret-value')
  })
})
