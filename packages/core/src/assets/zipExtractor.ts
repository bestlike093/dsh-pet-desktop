import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { mkdir, open, readdir, rename, rm, rmdir, stat } from 'node:fs/promises'
import { dirname, posix, resolve } from 'node:path'
import { createInflateRaw } from 'node:zlib'
import { ErrorCode, PetError } from '@pet/shared'
import { assertInsideRoot, assertNotSymlink } from './pathGuard.js'
import { extensionOf } from './uploadGuard.js'

const MB = 1024 * 1024
const EOCD_SIG = 0x06054b50
const CENTRAL_SIG = 0x02014b50
const LOCAL_SIG = 0x04034b50
const MAX_CENTRAL_DIRECTORY_BYTES = 4 * MB
const MAX_UINT16 = 0xffff
const MAX_UINT32 = 0xffffffff
const FLAG_ENCRYPTED = 0x0001
const FLAG_DATA_DESCRIPTOR = 0x0008

/** 压缩包内一律拒绝的类型：可执行、可注入脚本、可带外链的 SVG。 */
export const FORBIDDEN_ENTRY_EXTENSIONS: ReadonlySet<string> = new Set([
  '.js',
  '.html',
  '.htm',
  '.svg',
  '.exe',
  '.dll'
])

export interface ZipLimits {
  /** 允许的最大嵌套层数，外层算第 1 层。 */
  readonly maxDepth: number
  /** 整个压缩包（含嵌套）允许的条目总数。 */
  readonly maxEntries: number
  /** 实际解压出的字节总数；不看 zip 头里的未压缩大小。 */
  readonly maxTotalBytes: number
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxDepth: 3,
  maxEntries: 500,
  maxTotalBytes: 300 * MB
}

export interface ExtractZipResult {
  /** 成功落盘的相对路径，不含目录条目与嵌套包本身。 */
  readonly files: readonly string[]
  readonly entryCount: number
  readonly totalBytes: number
  /** 实际到达的最深层数。 */
  readonly maxDepth: number
}

interface Eocd {
  readonly cdOffset: number
  readonly cdSize: number
  readonly entryCount: number
}

interface CentralEntry {
  readonly name: string
  readonly flags: number
  readonly method: number
  readonly crc: number
  readonly compressedSize: number
  readonly uncompressedSize: number
  readonly localOffset: number
}

interface PlannedEntry {
  readonly entry: CentralEntry
  readonly cleaned: string
  readonly target: string
  readonly isDirectory: boolean
}

interface Counter {
  entries: number
  bytes: number
  maxDepth: number
  readonly files: string[]
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

function crc32Update(state: number, chunk: Buffer): number {
  let value = state
  for (const byte of chunk) value = CRC_TABLE[(value ^ byte) & 0xff]! ^ (value >>> 8)
  return value >>> 0
}

function bomb(message: string, details: Record<string, unknown> = {}): PetError {
  return new PetError(ErrorCode.ZIP_BOMB, message, { details })
}

function unsupported(message: string, details: Record<string, unknown> = {}): PetError {
  return new PetError(ErrorCode.NOT_SUPPORTED, message, { details })
}

async function readEocd(zipPath: string): Promise<Eocd> {
  const info = await stat(zipPath)
  if (info.size < 22) throw bomb('文件过小，不可能包含 zip 中央目录', { size: info.size })

  const tailLength = Math.min(info.size, 22 + 0xffff)
  const handle = await open(zipPath, 'r')
  try {
    const tail = Buffer.alloc(tailLength)
    await handle.read(tail, 0, tailLength, info.size - tailLength)

    for (let offset = tail.length - 22; offset >= 0; offset -= 1) {
      if (tail.readUInt32LE(offset) !== EOCD_SIG) continue

      const diskNumber = tail.readUInt16LE(offset + 4)
      const cdStartDisk = tail.readUInt16LE(offset + 6)
      const entryCount = tail.readUInt16LE(offset + 10)
      const cdSize = tail.readUInt32LE(offset + 12)
      const cdOffset = tail.readUInt32LE(offset + 16)

      if (diskNumber !== 0 || cdStartDisk !== 0) {
        throw unsupported('不支持分卷压缩包', { diskNumber, cdStartDisk })
      }

      if (entryCount === MAX_UINT16 || cdSize === MAX_UINT32 || cdOffset === MAX_UINT32) {
        throw unsupported('不支持 Zip64 压缩包')
      }

      if (cdSize > MAX_CENTRAL_DIRECTORY_BYTES) {
        throw bomb('中央目录过大', { cdSize })
      }

      return { cdOffset, cdSize, entryCount }
    }
  } finally {
    await handle.close()
  }

  throw bomb('找不到 zip 中央目录')
}

async function readCentralDirectory(zipPath: string, eocd: Eocd): Promise<CentralEntry[]> {
  const handle = await open(zipPath, 'r')
  try {
    const directory = Buffer.alloc(eocd.cdSize)
    await handle.read(directory, 0, eocd.cdSize, eocd.cdOffset)

    const entries: CentralEntry[] = []
    let offset = 0

    while (offset + 46 <= directory.length) {
      if (directory.readUInt32LE(offset) !== CENTRAL_SIG) break

      const flags = directory.readUInt16LE(offset + 8)
      const method = directory.readUInt16LE(offset + 10)
      const crc = directory.readUInt32LE(offset + 16)
      const compressedSize = directory.readUInt32LE(offset + 20)
      const uncompressedSize = directory.readUInt32LE(offset + 24)
      const nameLength = directory.readUInt16LE(offset + 28)
      const extraLength = directory.readUInt16LE(offset + 30)
      const commentLength = directory.readUInt16LE(offset + 32)
      const localOffset = directory.readUInt32LE(offset + 42)

      const name = directory.toString('utf8', offset + 46, offset + 46 + nameLength)

      if ((flags & FLAG_ENCRYPTED) !== 0) {
        throw unsupported('不支持加密条目', { entry: name })
      }

      if (
        compressedSize === MAX_UINT32 ||
        uncompressedSize === MAX_UINT32 ||
        localOffset === MAX_UINT32
      ) {
        throw unsupported('不支持 Zip64 条目', { entry: name })
      }

      entries.push({ name, flags, method, crc, compressedSize, uncompressedSize, localOffset })

      offset += 46 + nameLength + extraLength + commentLength
    }

    return entries
  } finally {
    await handle.close()
  }
}

/**
 * zip 内条目一律按 posix 语义归一，再交给 assertInsideRoot 复核。
 * `..` 与盘符在归一前就要拦，避免 normalize 把 `a/../..` 折叠成看似合法的一段。
 */
function normalizeEntryName(raw: string): string {
  const unified = raw.replace(/\\/g, '/')

  if (unified.startsWith('/') || /^[A-Za-z]:/.test(unified)) {
    throw new PetError(ErrorCode.PATH_TRAVERSAL, '压缩包条目使用绝对路径', {
      details: { entry: raw }
    })
  }

  const normalized = posix.normalize(unified)

  if (normalized === '..' || normalized.startsWith('../')) {
    throw new PetError(ErrorCode.PATH_TRAVERSAL, '压缩包条目越出目标目录', {
      details: { entry: raw, normalized }
    })
  }

  return normalized === '.' ? '' : normalized
}

function assertAllowedEntry(entryName: string): void {
  const extension = extensionOf(entryName)
  if (!FORBIDDEN_ENTRY_EXTENSIONS.has(extension)) return

  throw new PetError(ErrorCode.ASSET_FORBIDDEN_TYPE, '压缩包含禁止入库的文件类型', {
    details: { entry: entryName, extension }
  })
}

async function writeAll(handle: FileHandle, chunk: Buffer): Promise<void> {
  let offset = 0
  while (offset < chunk.length) {
    const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset)
    offset += bytesWritten
  }
}

/** 本地头与中央目录必须描述同一个实体，避免 zip 混淆攻击。 */
async function assertLocalHeaderMatches(
  entry: CentralEntry,
  localFlags: number,
  localMethod: number,
  localCrc: number,
  localCompressedSize: number,
  localUncompressedSize: number
): Promise<void> {
  if ((localFlags & FLAG_ENCRYPTED) !== 0 || (entry.flags & FLAG_ENCRYPTED) !== 0) {
    throw unsupported('不支持加密条目', { entry: entry.name })
  }

  if (localMethod !== entry.method) {
    throw bomb('中央目录与本地头的压缩方式不一致', {
      entry: entry.name,
      localMethod,
      centralMethod: entry.method
    })
  }

  // 置了 bit 3 时大小与 CRC 写在数据描述符里，本地头可以是 0。
  if ((localFlags & FLAG_DATA_DESCRIPTOR) !== 0) return

  if (localCompressedSize !== entry.compressedSize) {
    throw bomb('中央目录与本地头的压缩大小不一致', {
      entry: entry.name,
      localCompressedSize,
      centralCompressedSize: entry.compressedSize
    })
  }

  if (localUncompressedSize !== entry.uncompressedSize) {
    throw bomb('中央目录与本地头的未压缩大小不一致', {
      entry: entry.name,
      localUncompressedSize,
      centralUncompressedSize: entry.uncompressedSize
    })
  }

  if (localCrc !== entry.crc) {
    throw bomb('中央目录与本地头的 CRC 不一致', {
      entry: entry.name,
      localCrc,
      centralCrc: entry.crc
    })
  }
}

/** 只按中央目录记录的压缩大小读，不信任未压缩大小字段；写完再校验 CRC32。 */
async function writeEntry(
  zipPath: string,
  entry: CentralEntry,
  target: string,
  limits: ZipLimits,
  counter: Counter
): Promise<void> {
  const source = await open(zipPath, 'r')
  let out: FileHandle | undefined

  try {
    const header = Buffer.alloc(30)
    await source.read(header, 0, 30, entry.localOffset)

    if (header.readUInt32LE(0) !== LOCAL_SIG) {
      throw bomb('条目的本地头损坏', { entry: entry.name })
    }

    const nameLength = header.readUInt16LE(26)
    const extraLength = header.readUInt16LE(28)
    const dataStart = entry.localOffset + 30 + nameLength + extraLength

    const localName = Buffer.alloc(nameLength)
    if (nameLength > 0) {
      await source.read(localName, 0, nameLength, entry.localOffset + 30)
    }

    if (!localName.equals(Buffer.from(entry.name, 'utf8'))) {
      throw bomb('中央目录与本地头的文件名不一致', { entry: entry.name })
    }

    await assertLocalHeaderMatches(
      entry,
      header.readUInt16LE(6),
      header.readUInt16LE(8),
      header.readUInt32LE(14),
      header.readUInt32LE(18),
      header.readUInt32LE(22)
    )

    out = await open(target, 'wx')

    let crcState = 0xffffffff

    if (entry.compressedSize > 0) {
      const raw = createReadStream(zipPath, {
        start: dataStart,
        end: dataStart + entry.compressedSize - 1
      })

      let stream: AsyncIterable<Buffer>
      if (entry.method === 0) {
        stream = raw
      } else if (entry.method === 8) {
        stream = raw.pipe(createInflateRaw())
      } else {
        raw.destroy()
        throw unsupported('不支持的 zip 压缩方式', {
          entry: entry.name,
          method: entry.method
        })
      }

      for await (const chunk of stream) {
        counter.bytes += chunk.length

        if (counter.bytes > limits.maxTotalBytes) {
          if (typeof (stream as { destroy?: unknown }).destroy === 'function') {
            ;(stream as unknown as { destroy: () => void }).destroy()
          }
          throw bomb('解压后体积超过上限', {
            entry: entry.name,
            bytes: counter.bytes,
            maxTotalBytes: limits.maxTotalBytes
          })
        }

        crcState = crc32Update(crcState, chunk)
        await writeAll(out, chunk)
      }
    }

    const actualCrc = (crcState ^ 0xffffffff) >>> 0
    if (actualCrc !== entry.crc) {
      throw bomb('解压后 CRC32 与中央目录不一致', {
        entry: entry.name,
        actualCrc,
        expectedCrc: entry.crc
      })
    }
  } finally {
    await out?.close()
    await source.close()
  }
}

async function extractArchive(
  zipPath: string,
  destDir: string,
  limits: ZipLimits,
  depth: number,
  counter: Counter,
  prefix = ''
): Promise<void> {
  if (depth > limits.maxDepth) {
    throw bomb('压缩包嵌套层数超过上限', { depth, maxDepth: limits.maxDepth })
  }

  counter.maxDepth = Math.max(counter.maxDepth, depth)

  const eocd = await readEocd(zipPath)
  const entries = await readCentralDirectory(zipPath, eocd)

  // 解析出的条目数必须与 EOCD 声明一致，否则可能漏读完被当成空包放行。
  if (entries.length !== eocd.entryCount) {
    throw bomb('中央目录条目数与声明不一致', {
      parsed: entries.length,
      declared: eocd.entryCount
    })
  }

  // 先把全部条目收集并校验完，再统一落盘：同名覆盖绕不过前面的检查。
  const planned: PlannedEntry[] = []
  const seen = new Set<string>()

  for (const entry of entries) {
    counter.entries += 1
    if (counter.entries > limits.maxEntries) {
      throw bomb('条目数超过上限', { entries: counter.entries, maxEntries: limits.maxEntries })
    }

    const cleaned = normalizeEntryName(entry.name)
    if (cleaned === '') continue

    // Windows 文件名大小写不敏感，统一按小写判重。
    const key = cleaned.toLowerCase()
    if (seen.has(key)) {
      throw bomb('压缩包含重复条目名', { entry: cleaned })
    }
    seen.add(key)

    const target = assertInsideRoot(destDir, resolve(destDir, cleaned))

    if (cleaned.endsWith('/')) {
      planned.push({ entry, cleaned, target, isDirectory: true })
      continue
    }

    // 危险扩展名看最终落地的相对路径，不看压缩包外层名字。
    assertAllowedEntry(cleaned)
    planned.push({ entry, cleaned, target, isDirectory: false })
  }

  await mkdir(destDir, { recursive: true })

  for (const item of planned) {
    if (item.isDirectory) {
      await mkdir(item.target, { recursive: true })
      continue
    }

    await mkdir(dirname(item.target), { recursive: true })
    await assertNotSymlink(dirname(item.target))
    await assertNotSymlink(item.target)

    const isNestedZip = extensionOf(item.cleaned) === '.zip'

    if (isNestedZip) {
      if (depth >= limits.maxDepth) {
        throw bomb('嵌套压缩包超过允许层数', {
          entry: item.cleaned,
          depth,
          maxDepth: limits.maxDepth
        })
      }

      const nestedPath = resolve(destDir, `.nested-${randomUUID()}.zip`)
      await writeEntry(zipPath, item.entry, nestedPath, limits, counter)
      try {
        await extractArchive(
          nestedPath,
          assertInsideRoot(destDir, resolve(destDir, item.cleaned.slice(0, -4))),
          limits,
          depth + 1,
          counter,
          `${prefix}${item.cleaned.slice(0, -4)}/`
        )
      } finally {
        await rm(nestedPath, { force: true })
      }
      continue
    }

    await writeEntry(zipPath, item.entry, item.target, limits, counter)
    counter.files.push(`${prefix}${item.cleaned}`)
  }
}

/**
 * 把 zip 解压到 `destDir`。
 *
 * 先解到同父目录的 staging，成功后才 rename 到目标。
 * 任何一步失败只删 staging，绝不对 `destDir` 做递归删除：
 * 调用方传进来的目录可能已经有用户文件，失败不能把它们一起带走。
 */
export async function extractZipSafely(
  zipPath: string,
  destDir: string,
  limits: Partial<ZipLimits> = {}
): Promise<ExtractZipResult> {
  const resolvedLimits: ZipLimits = { ...DEFAULT_ZIP_LIMITS, ...limits }
  const root = resolve(destDir)
  const staging = resolve(dirname(root), `.extract-${randomUUID()}`)
  const counter: Counter = { entries: 0, bytes: 0, maxDepth: 0, files: [] }

  try {
    // 目标是符号链接时直接拒绝：rename 会把内容落到链接指向的位置。
    await assertNotSymlink(root)

    const existing = await stat(root).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined
      throw error
    })

    if (existing !== undefined) {
      if (!existing.isDirectory()) {
        throw new PetError(ErrorCode.INVALID_ARGUMENT, '解压目标必须是目录')
      }
      const entries = await readdir(root)
      if (entries.length > 0) {
        throw new PetError(ErrorCode.INVALID_ARGUMENT, '解压目标必须为空目录')
      }
    }

    await extractArchive(zipPath, staging, resolvedLimits, 1, counter)

    // 空目录先移除再 rename；Windows 不允许 rename 覆盖已存在目录。
    if (existing !== undefined) await rmdir(root)
    await rename(staging, root)
  } catch (error) {
    await rm(staging, { recursive: true, force: true })
    throw error
  }

  return {
    files: counter.files,
    entryCount: counter.entries,
    totalBytes: counter.bytes,
    maxDepth: counter.maxDepth
  }
}
