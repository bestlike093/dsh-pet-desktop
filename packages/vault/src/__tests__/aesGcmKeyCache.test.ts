import { describe, expect, it, vi } from 'vitest'
import { AesGcmProvider } from '../crypto/provider.js'

const PLAINTEXT = new TextEncoder().encode('hello')
const AAD = new TextEncoder().encode('aad')

describe('AesGcmProvider 密钥缓存', () => {
  it('内容相同但引用不同的 key 只导入一次', async () => {
    const provider = new AesGcmProvider()
    const importKey = vi.spyOn(globalThis.crypto.subtle, 'importKey')

    try {
      const key = new Uint8Array(32).fill(7)
      await provider.seal(key, PLAINTEXT, AAD)
      await provider.seal(key.slice(), PLAINTEXT, AAD)
      await provider.seal(Uint8Array.from(key), PLAINTEXT, AAD)

      expect(importKey).toHaveBeenCalledTimes(1)
    } finally {
      importKey.mockRestore()
    }
  })

  it('内容不同时重新导入', async () => {
    const provider = new AesGcmProvider()
    const importKey = vi.spyOn(globalThis.crypto.subtle, 'importKey')

    try {
      await provider.seal(new Uint8Array(32).fill(7), PLAINTEXT, AAD)
      await provider.seal(new Uint8Array(32).fill(8), PLAINTEXT, AAD)

      expect(importKey).toHaveBeenCalledTimes(2)
    } finally {
      importKey.mockRestore()
    }
  })
})
