import { deflateRawSync } from 'node:zlib'

export interface FixtureEntry {
  readonly name: string
  readonly data?: Buffer | string
  /** 0 = store，8 = deflate；默认 store。 */
  readonly method?: 0 | 8
  /** 伪造中央目录与本地头的未压缩大小，用来验证实现不信任该字段。 */
  readonly fakeUncompressedSize?: number
  /** 伪造 CRC，用来验证解压后的校验。 */
  readonly fakeCrc?: number
  /** 写入中央目录与本地头的通用标志位（如加密位）。 */
  readonly flags?: number
  /** 只改本地头的压缩方式，制造中央目录不一致。 */
  readonly localMethod?: number
  /** 只改本地头的文件名；必须与原文件名等长，避免破坏结构。 */
  readonly localName?: string
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
})()

function crc32(buffer: Buffer): number {
  let value = 0xffffffff
  for (const byte of buffer) {
    value = CRC_TABLE[(value ^ byte) & 0xff]! ^ (value >>> 8)
  }
  return (value ^ 0xffffffff) >>> 0
}

/** 生成最小可用的 zip（store / deflate），够测解压守卫。 */
export function makeZip(entries: readonly FixtureEntry[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let localOffset = 0

  for (const entry of entries) {
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data ?? '', 'utf8')
    const method = entry.method ?? 0
    const payload = method === 8 ? deflateRawSync(raw) : raw
    const name = Buffer.from(entry.name, 'utf8')
    const localName = entry.localName === undefined ? name : Buffer.from(entry.localName, 'utf8')
    const crc = entry.fakeCrc ?? crc32(raw)
    const uncompressedSize = entry.fakeUncompressedSize ?? raw.length
    const flags = entry.flags ?? 0

    if (localName.length !== name.length) {
      throw new Error('localName 必须与原文件名等长')
    }

    const local = Buffer.alloc(30 + name.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(flags, 6)
    local.writeUInt16LE(entry.localMethod ?? method, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(payload.length, 18)
    local.writeUInt32LE(uncompressedSize, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    localName.copy(local, 30)

    const central = Buffer.alloc(46 + name.length)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(flags, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(payload.length, 20)
    central.writeUInt32LE(uncompressedSize, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(localOffset, 42)
    name.copy(central, 46)

    locals.push(local, payload)
    centrals.push(central)
    localOffset += local.length + payload.length
  }

  const centralDirectory = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralDirectory.length, 12)
  eocd.writeUInt32LE(localOffset, 16)
  eocd.writeUInt16LE(0, 20)

  return Buffer.concat([...locals, centralDirectory, eocd])
}
