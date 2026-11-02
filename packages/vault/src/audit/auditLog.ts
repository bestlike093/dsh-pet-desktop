import { createHash } from 'node:crypto'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { ErrorCode, PetError } from '@pet/shared'
import { restrictPermissions } from '../crypto/fileKeyRing.js'

export type AuditEvent =
  | 'seal'
  | 'open'
  | 'rotate'
  | 'key_backend_insecure'
  | 'tamper_detected'
  | 'llm_key_stored'
  | 'llm_key_cleared'
  | 'llm_key_migrated'
  | 'service_key_stored'
  | 'service_key_cleared'

/** 只允许放非敏感摘要；明文、密钥、token 一律不得进入审计日志。 */
export interface AuditDetails {
  readonly keyId?: number
  readonly epoch?: number
  readonly size?: number
  readonly backend?: string
  readonly code?: string
  readonly note?: string
  readonly appVersion?: string
  /** 触发来源：user=显式动作，system=自动检测/恢复，test=测试。自动确认只可能是 system，属于 bug。 */
  readonly source?: 'user' | 'system' | 'test'
  readonly backupPath?: string
}

export interface AuditEntry {
  readonly seq: number
  readonly ts: number
  readonly event: AuditEvent
  readonly details: AuditDetails
  readonly prevHash: string
  readonly hash: string
}

export interface AuditLog {
  append(event: AuditEvent, details?: AuditDetails): Promise<AuditEntry>
  verify(): Promise<void>
  entries(): Promise<readonly AuditEntry[]>
}

const GENESIS_HASH = '0'.repeat(64)

function computeHash(entry: Omit<AuditEntry, 'hash'>): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        seq: entry.seq,
        ts: entry.ts,
        event: entry.event,
        details: entry.details,
        prevHash: entry.prevHash
      })
    )
    .digest('hex')
}

function parseLine(line: string, lineNo: number): AuditEntry {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch (error) {
    throw new PetError(ErrorCode.VAULT_TAMPERED, `审计日志第 ${lineNo} 行不是合法 JSON`, {
      cause: error
    })
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new PetError(ErrorCode.VAULT_TAMPERED, `审计日志第 ${lineNo} 行必须是对象`)
  }
  const record = value as Record<string, unknown>
  if (
    typeof record['seq'] !== 'number' ||
    typeof record['ts'] !== 'number' ||
    typeof record['event'] !== 'string' ||
    typeof record['prevHash'] !== 'string' ||
    typeof record['hash'] !== 'string'
  ) {
    throw new PetError(ErrorCode.VAULT_TAMPERED, `审计日志第 ${lineNo} 行字段缺失`)
  }
  const details =
    typeof record['details'] === 'object' && record['details'] !== null
      ? (record['details'] as AuditDetails)
      : {}
  return {
    seq: record['seq'],
    ts: record['ts'],
    event: record['event'] as AuditEvent,
    details,
    prevHash: record['prevHash'],
    hash: record['hash']
  }
}

async function readEntries(path: string): Promise<AuditEntry[]> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line, index) => parseLine(line, index + 1))
}

/** 顺序、前向哈希、自身哈希三者任一不符都视为落盘数据被改动。 */
function verifyChain(entries: readonly AuditEntry[]): void {
  let prevHash = GENESIS_HASH
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]
    if (entry === undefined) continue
    if (entry.seq !== index + 1) {
      throw new PetError(ErrorCode.VAULT_TAMPERED, `审计日志序号断裂：第 ${index + 1} 条 seq=${entry.seq}`)
    }
    if (entry.prevHash !== prevHash) {
      throw new PetError(ErrorCode.VAULT_TAMPERED, `审计日志链断裂：seq=${entry.seq} 的 prevHash 不匹配`)
    }
    const expected = computeHash(entry)
    if (entry.hash !== expected) {
      throw new PetError(ErrorCode.VAULT_TAMPERED, `审计日志哈希不匹配：seq=${entry.seq}`)
    }
    prevHash = entry.hash
  }
}

/**
 * 纯 append-only 审计日志（JSON Lines）。
 * 首版不做 Merkle root（17.5 不做清单），用逐条前向哈希保证删行/改行可被发现。
 */
export async function createAuditLog(path: string): Promise<AuditLog> {
  const existing = await readEntries(path)
  verifyChain(existing)

  let lastHash = existing.length > 0 ? (existing[existing.length - 1]?.hash ?? GENESIS_HASH) : GENESIS_HASH
  let nextSeq = existing.length + 1
  let queue: Promise<unknown> = Promise.resolve()

  await mkdir(dirname(path), { recursive: true })
  if (existing.length === 0) {
    await writeFile(path, '', { encoding: 'utf8', mode: 0o600 })
    await restrictPermissions(path)
  }

  const append = (event: AuditEvent, details: AuditDetails = {}): Promise<AuditEntry> => {
    const run = async (): Promise<AuditEntry> => {
      const base: Omit<AuditEntry, 'hash'> = {
        seq: nextSeq,
        ts: Date.now(),
        event,
        details,
        prevHash: lastHash
      }
      const entry: AuditEntry = { ...base, hash: computeHash(base) }
      await appendFile(path, JSON.stringify(entry) + '\n', 'utf8')
      lastHash = entry.hash
      nextSeq += 1
      return entry
    }
    const result = queue.then(run, run)
    queue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  return {
    append,
    async verify() {
      verifyChain(await readEntries(path))
    },
    async entries() {
      return readEntries(path)
    }
  }
}
