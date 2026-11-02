import { ErrorCode } from '@pet/shared'
import { describe, expect, it } from 'vitest'
import { createEphemeralKeyRing, toBase64Url } from '../crypto/keyRing.js'
import { AesGcmProvider } from '../crypto/provider.js'
import { MemoryVaultStorage } from '../store/vaultStore.js'
import { VaultClient } from '../vaultClient.js'

function createClient(): VaultClient {
  return new VaultClient(new MemoryVaultStorage(), new AesGcmProvider(), createEphemeralKeyRing())
}

function flipLastByte(cipher: string): string {
  const b64 = cipher.replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0xff

  let out = ''
  for (const byte of bytes) out += String.fromCharCode(byte)
  return btoa(out).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

describe('VaultClient seal/open（S1 第一刀）', () => {
  it('空字节往返相等', async () => {
    const client = createClient()
    const sealed = await client.seal(new Uint8Array(0), { kind: 'envelope' })
    const opened = await client.open(sealed)
    expect(opened).toEqual(new Uint8Array(0))
  })

  it('对象往返相等', async () => {
    const client = createClient()
    const sealed = await client.seal({ hello: 'world', n: 42 }, { kind: 'envelope' })
    const opened = await client.open(sealed)
    expect(JSON.parse(new TextDecoder().decode(opened))).toEqual({ hello: 'world', n: 42 })
  })

  it('改 1 字节被拒', async () => {
    const client = createClient()
    const sealed = await client.seal(new Uint8Array([1, 2, 3]), { kind: 'envelope' })
    await expect(client.open({ ...sealed, cipher: flipLastByte(sealed.cipher) })).rejects.toThrow()
  })

  it('未知 keyId 被拒', async () => {
    const client = createClient()
    const sealed = await client.seal(new Uint8Array([1]), { kind: 'envelope' })
    await expect(client.open({ ...sealed, keyEpoch: 999 })).rejects.toThrow()
  })
})

function decodeBase64Url(value: string): Uint8Array {
  const padded =
    value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4)
  const bin = atob(padded)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

describe('四类攻击', () => {
  it('改 ver / cs / keyId / nonce / ct / tag 任一字节都被拒', async () => {
    const client = createClient()
    const sealed = await client.seal(new Uint8Array([7, 8, 9]), { kind: 'envelope' })
    const raw = decodeBase64Url(sealed.cipher)
    const offsets = [0, 1, 2, 5, 6, 18, raw.byteLength - 1]

    for (const offset of offsets) {
      const copy = new Uint8Array(raw)
      copy[offset] = (copy[offset] ?? 0) ^ 0xff
      await expect(
        client.open({ ...sealed, cipher: toBase64Url(copy) }),
        `offset ${offset}`
      ).rejects.toThrow()
    }
  })

  it('换签名被拒（SIGNATURE_INVALID）', async () => {
    const client = createClient()
    const sealed = await client.seal(new Uint8Array([1, 2, 3]), { kind: 'envelope' })
    await expect(
      client.open({ ...sealed, sig: flipLastByte(sealed.sig) })
    ).rejects.toMatchObject({ code: ErrorCode.SIGNATURE_INVALID })
  })

  it('重放同一信封被拒（REPLAY_DETECTED）', async () => {
    const client = createClient()
    const sealed = await client.seal(new Uint8Array([4, 5, 6]), { kind: 'envelope' })

    await expect(client.open(sealed)).resolves.toEqual(new Uint8Array([4, 5, 6]))
    await expect(client.open(sealed)).rejects.toMatchObject({ code: ErrorCode.REPLAY_DETECTED })
  })

  it('keyEpoch 超窗被拒（VAULT_TAMPERED）', async () => {
    const client = createClient()
    const sealed = await client.seal(new Uint8Array([1]), { kind: 'envelope' })
    await expect(
      client.open({ ...sealed, keyEpoch: sealed.keyEpoch + 1 })
    ).rejects.toMatchObject({ code: ErrorCode.VAULT_TAMPERED })
  })
})

describe('rotate', () => {
  it('连续轮换后，两代旧密文在 allowLegacyEpoch 下仍可读（桌面壳的读取方式）', async () => {
    const client = createClient()
    const first = await client.seal(new Uint8Array([1]), { kind: 'envelope' })
    await client.rotate()
    const second = await client.seal(new Uint8Array([2]), { kind: 'envelope' })
    await client.rotate()

    await expect(client.open(first, { allowLegacyEpoch: true })).resolves.toEqual(new Uint8Array([1]))
    await expect(client.open(second, { allowLegacyEpoch: true })).resolves.toEqual(
      new Uint8Array([2])
    )
  })

  it('旋转后新信封用新 epoch，旧信封默认拒绝、显式放行后可读', async () => {
    const client = createClient()
    const before = client.keyEpoch
    const oldSealed = await client.seal(new Uint8Array([1]), { kind: 'envelope' })

    const result = await client.rotate()
    expect(result).toEqual({ from: before, to: before + 1 })
    expect(client.keyEpoch).toBe(before + 1)

    await expect(client.open(oldSealed)).rejects.toMatchObject({ code: ErrorCode.VAULT_TAMPERED })
    await expect(client.open(oldSealed, { allowLegacyEpoch: true })).resolves.toEqual(
      new Uint8Array([1])
    )

    const newSealed = await client.seal(new Uint8Array([2]), { kind: 'envelope' })
    expect(newSealed.keyEpoch).toBe(before + 1)
    expect(newSealed.cipher).not.toBe(oldSealed.cipher)
    await expect(client.open(newSealed)).resolves.toEqual(new Uint8Array([2]))
  })

  it('连续旋转的 epoch 单调递增', async () => {
    const client = createClient()
    const first = await client.rotate()
    const second = await client.rotate()
    expect(second.from).toBe(first.to)
    expect(second.to).toBe(first.to + 1)
  })
})
