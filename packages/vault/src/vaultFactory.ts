import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { CryptoSuiteId } from '@pet/shared'
import { ErrorCode } from '@pet/shared'
import type { AuditLog } from './audit/auditLog.js'
import {
  createFileKeyRing,
  restrictPermissions,
  type FileKeyRing,
  type FileKeyRingDiagnostic
} from './crypto/fileKeyRing.js'
import {
  createSystemKeyBackend,
  type KeyBackend,
  type SafeStorageLike
} from './crypto/keyBackend.js'

export type DiagnosticSeverity = 'ok' | 'error'
export type DiagnosticCode = 'OK' | 'KEY_BACKEND_INSECURE' | 'KEY_FILE_PERMISSION'

const LOCAL_STATE_VERSION = 1

/**
 * 本机状态：只记录「当前这台机器上，用户确认过哪个后端」。
 * 不得写入 settings.json 或任何会随配置导出的文件；换机器、重装后应视为未确认。
 */
interface LocalVaultState {
  readonly acknowledgedBackend?: string
}

async function loadLocalState(path: string | undefined): Promise<LocalVaultState> {
  if (path === undefined) return {}
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as {
      version?: number
      acknowledgedBackend?: unknown
    }
    if (parsed.version !== LOCAL_STATE_VERSION) return {}
    return typeof parsed.acknowledgedBackend === 'string'
      ? { acknowledgedBackend: parsed.acknowledgedBackend }
      : {}
  } catch {
    // 不存在或已损坏：一律当作未确认，不把损坏文件当成有效凭据。
    return {}
  }
}

async function saveLocalState(path: string | undefined, state: LocalVaultState): Promise<void> {
  if (path === undefined) return
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.tmp`
  await writeFile(temp, JSON.stringify({ version: LOCAL_STATE_VERSION, ...state }), {
    encoding: 'utf8',
    mode: 0o600
  })
  await rename(temp, path)
  await restrictPermissions(path)
}

export interface VaultDiagnostic extends FileKeyRingDiagnostic {
  readonly severity: DiagnosticSeverity
  readonly code: DiagnosticCode
  /** 诊断项细分类；归入 credential 组，渲染时按 group → kind 两级展开。 */
  readonly kind: 'secure'
  readonly group: 'credential'
  /**
   * 只代表「用户已对当前后端显式确认」，仅用于抑制重复弹窗。
   * 不参与「是否允许在不安全后端下运行」的决策，不降低 severity，
   * 不跨后端继承，也不会由任何默认值/缓存自动置 true。
   */
  readonly acknowledged: boolean
  readonly message: string
}

export interface CreateVaultOptions {
  readonly keyFilePath: string
  /**
   * memory 后端只能显式注入；不传时一律要求系统后端，
   * 缺后端时明确失败，禁止静默落到 memory。
   */
  readonly backend?: KeyBackend
  readonly safeStorage?: SafeStorageLike
  readonly suite?: CryptoSuiteId
  /** 审计日志；确认不安全后端会写一条 key_backend_insecure。 */
  readonly audit?: AuditLog
  /**
   * 本机状态文件（state.json）。只放确认态，禁止指向可迁移配置。
   * 不传时确认态只存内存，重启即视为未确认。
   */
  readonly stateFilePath?: string
  /** 写入审计的 app 版本，便于事后定位是哪一版触发的确认/恢复。 */
  readonly appVersion?: string
}

export interface VaultAssembly {
  readonly ring: FileKeyRing
  /** 备份恢复需要用它把密钥重新包裹成当前机器的格式。 */
  readonly backend: KeyBackend
  diagnose(): Promise<VaultDiagnostic>
  /** 唯一能把 acknowledged 置 true 的入口：必须由用户显式动作触发。 */
  acknowledgeInsecure(): Promise<VaultDiagnostic>
}

/**
 * 装配工厂：只依赖 KeyRing / KeyBackend 两个抽象。
 * 诊断先接，装配后接；`secure=false` 是保护失效，诊断级别固定为 error（❌）。
 */
export async function createVault(options: CreateVaultOptions): Promise<VaultAssembly> {
  const backend = options.backend ?? (await createSystemKeyBackend(options.safeStorage))
  const ring = await createFileKeyRing({
    path: options.keyFilePath,
    backend,
    suite: options.suite
  })

  const localState = await loadLocalState(options.stateFilePath)
  /** 已确认的后端身份；来源是本机 state.json 或本次运行的显式确认。 */
  let acknowledgedKey: string | null = localState.acknowledgedBackend ?? null
  let recoveryAudited = false

  const buildDiagnostic = async (): Promise<VaultDiagnostic> => {
    const diagnostic = await ring.diagnostics()
    const key = `${diagnostic.backend}:${String(diagnostic.secure)}`

    // 后端一变，旧确认立即作废；同步清掉本机状态，切回旧后端也不会复活。
    if (acknowledgedKey !== null && acknowledgedKey !== key) {
      acknowledgedKey = null
      await saveLocalState(options.stateFilePath, {})
    }

    // 密钥文件解不开时只发生一次系统级恢复：留证据、写审计，绝不静默继续。
    if (!recoveryAudited && diagnostic.recoveredFrom !== undefined) {
      recoveryAudited = true
      await options.audit?.append('tamper_detected', {
        code: ErrorCode.VAULT_TAMPERED,
        backend: diagnostic.backend,
        source: 'system',
        backupPath: diagnostic.recoveredFrom,
        ...(options.appVersion === undefined ? {} : { appVersion: options.appVersion }),
        note: '密钥文件无法解开：已改名保留证据并重新初始化'
      })
    }

    if (!diagnostic.secure) {
      return {
        ...diagnostic,
        severity: 'error',
        code: 'KEY_BACKEND_INSECURE',
        kind: 'secure',
        group: 'credential',
        acknowledged: acknowledgedKey === key,
        message: '密钥后端不提供真实保护（secure=false），用户必须在设置中显式确认后才能继续'
      }
    }

    if (diagnostic.permission !== 'ok') {
      return {
        ...diagnostic,
        severity: 'error',
        code: 'KEY_FILE_PERMISSION',
        kind: 'secure',
        group: 'credential',
        acknowledged: false,
        message: `密钥文件权限异常：${diagnostic.permission}`
      }
    }

    return {
      ...diagnostic,
      severity: 'ok',
      code: 'OK',
      kind: 'secure',
      group: 'credential',
      // 后端安全时没有待确认项；保持 false，避免「一次确认」被误读为持续有效。
      acknowledged: false,
      message: '密钥后端与文件权限正常'
    }
  }

  return {
    ring,
    backend,
    diagnose: buildDiagnostic,
    async acknowledgeInsecure() {
      const diagnostic = await ring.diagnostics()
      if (!diagnostic.secure) {
        // 先写审计，再落本机状态，最后置内存；任一步失败都不算确认成功。
        await options.audit?.append('key_backend_insecure', {
          backend: diagnostic.backend,
          keyId: ring.current().keyId,
          source: 'user',
          ...(options.appVersion === undefined ? {} : { appVersion: options.appVersion }),
          note: '用户显式确认不安全密钥后端'
        })
        const key = `${diagnostic.backend}:${String(diagnostic.secure)}`
        await saveLocalState(options.stateFilePath, { acknowledgedBackend: key })
        acknowledgedKey = key
      }
      return buildDiagnostic()
    }
  }
}
