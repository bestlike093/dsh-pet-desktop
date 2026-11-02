import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { formatHlc } from '@pet/shared'
import { afterEach, describe, expect, it } from 'vitest'
import {
  SYNC_PACKET_FORMAT,
  SYNC_PACKET_VERSION,
  createFileSyncTransport
} from '../sync/fileSyncTransport.js'
import { SyncEngine } from '../sync/syncEngine.js'

const dirs: string[] = []

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-sync-'))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

async function writePacket(
  dir: string,
  node: string,
  file: string,
  body: unknown
): Promise<string> {
  const nodeDir = join(dir, node)
  await mkdir(nodeDir, { recursive: true })
  const path = join(nodeDir, file)
  await writeFile(path, JSON.stringify(body), 'utf8')
  return path
}

describe('本机目录同步闭环', () => {
  it('A 写、B 读、B 合并，拿到 A 的值', async () => {
    const dir = await tempDir()
    const a = new SyncEngine({ node: 'A' })
    const b = new SyncEngine({ node: 'B' })
    const transportA = createFileSyncTransport({ dir, node: 'A' })
    const transportB = createFileSyncTransport({ dir, node: 'B' })

    a.put('nickname', '小鹿')
    await transportA.publish(a.since())

    // 自己写下的包不会被自己读回。
    expect((await transportA.collect()).packets).toHaveLength(0)

    const collected = await transportB.collect()
    expect(collected.packets).toHaveLength(1)
    expect(collected.packets[0]?.changeSet.node).toBe('A')

    const merged = b.merge(collected.packets[0]!.changeSet)
    expect(b.get('nickname')?.value).toBe('小鹿')
    expect(merged.conflicts).toEqual([])

    await transportB.ack(collected.packets.map((packet) => packet.path))
    expect((await transportB.collect()).packets).toHaveLength(0)
  })

  it('两端都改同一键时按 HLC 决出胜负', async () => {
    const dir = await tempDir()
    const a = new SyncEngine({ node: 'A' })
    const b = new SyncEngine({ node: 'B' })
    const transportA = createFileSyncTransport({ dir, node: 'A' })
    const transportB = createFileSyncTransport({ dir, node: 'B' })

    a.put('theme', { preset: 'light' })
    await transportA.publish(a.since())

    const fromA = await transportB.collect()
    b.merge(fromA.packets[0]!.changeSet)

    // B 在合并之后再写，HLC 一定不小于 A 的时间戳。
    b.put('theme', { preset: 'dark' })
    await transportB.publish(b.since())

    const fromB = await transportA.collect()
    const result = a.merge(fromB.packets[0]!.changeSet)
    expect(a.get('theme')?.value).toEqual({ preset: 'dark' })
    expect(result.conflicts.some((item) => item.key === 'theme' && item.winner === 'remote')).toBe(
      true
    )
  })

  it('同一个包重放不会改变结果', async () => {
    const dir = await tempDir()
    const a = new SyncEngine({ node: 'A' })
    const b = new SyncEngine({ node: 'B' })
    const transportA = createFileSyncTransport({ dir, node: 'A' })
    const transportB = createFileSyncTransport({ dir, node: 'B' })

    a.put('locale', 'zh-CN')
    await transportA.publish(a.since())

    const packet = (await transportB.collect()).packets[0]!
    b.merge(packet.changeSet)
    const replay = b.merge(packet.changeSet)

    expect(replay.conflicts).toEqual([])
    expect(b.get('locale')?.value).toBe('zh-CN')
  })

  it('超出时钟偏差的包整批拒绝', async () => {
    const dir = await tempDir()
    const b = new SyncEngine({ node: 'B' })
    const transportB = createFileSyncTransport({ dir, node: 'B' })

    const stale = formatHlc({ wall: Date.now() - 10 * 60 * 1000, counter: 0, node: 'OLD' })
    await writePacket(dir, 'OLD', 'stale.json', {
      format: SYNC_PACKET_FORMAT,
      version: SYNC_PACKET_VERSION,
      changeSet: {
        node: 'OLD',
        records: [{ key: 'nickname', value: '旧包', hlc: stale }]
      }
    })

    const collected = await transportB.collect()
    expect(collected.packets).toHaveLength(1)
    expect(() => b.merge(collected.packets[0]!.changeSet)).toThrowError(
      expect.objectContaining({ code: 'TIMESTAMP_EXPIRED' })
    )
    expect(b.get('nickname')).toBeUndefined()
  })

  it('坏包被跳过，不影响同目录里的好包', async () => {
    const dir = await tempDir()
    const b = new SyncEngine({ node: 'B' })
    const transportB = createFileSyncTransport({ dir, node: 'B' })
    const a = new SyncEngine({ node: 'A' })
    const transportA = createFileSyncTransport({ dir, node: 'A' })

    await writePacket(dir, 'BAD', 'broken.json', { format: 'not-a-sync-packet' })
    a.put('nickname', '好包')
    await transportA.publish(a.since())

    const collected = await transportB.collect()
    expect(collected.skipped).toHaveLength(1)
    expect(collected.packets).toHaveLength(1)
    b.merge(collected.packets[0]!.changeSet)
    expect(b.get('nickname')?.value).toBe('好包')
  })

  it('节点名与单包体积都有上限', async () => {
    const dir = await tempDir()
    expect(() => createFileSyncTransport({ dir, node: '../escape' })).toThrowError(
      expect.objectContaining({ code: 'INVALID_ARGUMENT' })
    )

    const a = new SyncEngine({ node: 'A' })
    const transport = createFileSyncTransport({ dir, node: 'A', maxPacketBytes: 64 })
    a.put('nickname', 'x'.repeat(200))
    await expect(transport.publish(a.since())).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT'
    })
  })
})
