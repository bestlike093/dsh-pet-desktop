import { describe, expect, it } from 'vitest'
import { BlobUrlLedger } from '../resourceLedger.js'

function fakeFactory(): { factory: { create: (blob: Blob | MediaSource) => string; revoke: (url: string) => void }; revoked: string[] } {
  const revoked: string[] = []
  let seq = 0
  return {
    revoked,
    factory: {
      create: () => `blob:mock/${(seq += 1)}`,
      revoke: (url) => revoked.push(url)
    }
  }
}

describe('BlobUrlLedger', () => {
  it('切源 20 次：未释放数量恒为 1，revoke 次数为 19', () => {
    const { factory, revoked } = fakeFactory()
    const ledger = new BlobUrlLedger({ factory })

    let previous: string | null = null
    for (let i = 0; i < 20; i += 1) {
      const url = ledger.create({} as Blob)
      if (previous !== null) ledger.release(previous)
      previous = url
    }

    expect(ledger.liveCount).toBe(1)
    expect(revoked).toHaveLength(19)
    expect(ledger.isLive(previous as string)).toBe(true)
  })

  it('release 幂等：重复释放不会二次 revoke', () => {
    const { factory, revoked } = fakeFactory()
    const ledger = new BlobUrlLedger({ factory })
    const url = ledger.create({} as Blob)

    ledger.release(url)
    ledger.release(url)

    expect(revoked).toEqual([url])
    expect(ledger.isLive(url)).toBe(false)
  })

  it('未登记的 URL 不会触发 revoke', () => {
    const { factory, revoked } = fakeFactory()
    const ledger = new BlobUrlLedger({ factory })

    ledger.release('blob:never-registered')

    expect(revoked).toEqual([])
    expect(ledger.liveCount).toBe(0)
  })

  it('releaseAll 清空登记表', () => {
    const { factory, revoked } = fakeFactory()
    const ledger = new BlobUrlLedger({ factory })
    ledger.create({} as Blob)
    ledger.create({} as Blob)

    ledger.releaseAll()

    expect(ledger.liveCount).toBe(0)
    expect(revoked).toHaveLength(2)
  })

  it('切源 20 次后 dispose：表 size 归零，20 个 URL 全部 revoke', () => {
    const { factory, revoked } = fakeFactory()
    const ledger = new BlobUrlLedger({ factory })

    let previous: string | null = null
    for (let i = 0; i < 20; i += 1) {
      const url = ledger.create({} as Blob)
      if (previous !== null) ledger.release(previous)
      previous = url
    }

    expect(ledger.liveCount).toBe(1)

    ledger.dispose()

    expect(ledger.liveCount).toBe(0)
    expect(revoked).toHaveLength(20)
  })
})
