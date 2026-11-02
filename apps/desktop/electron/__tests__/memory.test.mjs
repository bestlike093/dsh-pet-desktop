import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMemoryStore } from '../memory.mjs'

const tempDirs = []

async function tempFile() {
  const dir = await mkdtemp(path.join(tmpdir(), 'pet-memory-'))
  tempDirs.push(dir)
  return path.join(dir, 'memory.bin')
}

function makeStore(filePath, overrides = {}) {
  return createMemoryStore({
    filePath,
    seal: async (value) => value,
    open: async (sealed) => new TextEncoder().encode(JSON.stringify(sealed)),
    log: vi.fn(),
    ...overrides
  })
}

function texts(store) {
  return store.recent(10).map((item) => item.text)
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('memory store clear 语义', () => {
  it('clear 成功：先落盘空记录，再归零内存', async () => {
    const filePath = await tempFile()
    const store = makeStore(filePath)
    store.appendTurn('user', '你好')
    store.appendTurn('assistant', '在的')
    expect(await store.flush()).toBe(true)
    expect(texts(store)).toEqual(['你好', '在的'])

    const result = await store.clear()

    expect(result).toEqual({ ok: true })
    expect(texts(store)).toEqual([])

    // 磁盘文件仍在，但内容是空记录；不断言文件不存在。
    const sealed = JSON.parse(await readFile(filePath, 'utf8'))
    expect(sealed.records).toEqual([])

    // 模拟重启：重新 load 后读出来也是空。
    const restarted = makeStore(filePath)
    const loaded = await restarted.load()
    expect(loaded).toEqual({ ok: true, count: 0 })
    expect(texts(restarted)).toEqual([])
  })

  it('clear 失败：内存恢复原数组，返回 persist-failed，磁盘仍是旧记录', async () => {
    const filePath = await tempFile()
    let sealCalls = 0
    const seal = async (value) => {
      sealCalls += 1
      if (sealCalls === 2) throw new Error('disk full')
      return value
    }
    const store = makeStore(filePath, { seal })
    store.appendTurn('user', '你好')
    store.appendTurn('assistant', '在的')
    expect(await store.flush()).toBe(true)

    const result = await store.clear()

    expect(result).toEqual({ ok: false, reason: 'persist-failed' })
    expect(texts(store)).toEqual(['你好', '在的'])

    // 失败路径不写盘；重新 load 后内容与 clear 前逐条一致。
    await store.load()
    expect(texts(store)).toEqual(['你好', '在的'])
  })

  it('并发 clear 复用同一个 promise 与结果对象，只触发一次落盘', async () => {
    const filePath = await tempFile()
    let sealCalls = 0
    const seal = async (value) => {
      sealCalls += 1
      return value
    }
    const store = makeStore(filePath, { seal })
    store.appendTurn('user', '你好')
    await store.flush()
    const before = sealCalls

    const first = store.clear()
    const second = store.clear()

    expect(first).toBe(second)
    const [a, b] = await Promise.all([first, second])
    expect(a).toBe(b)
    expect(a).toEqual({ ok: true })
    expect(sealCalls - before).toBe(1)
  })
})
