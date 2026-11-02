import type { Diagnostics, DiagnosticsSection } from './diagnostics.js'
import type { PanelRow } from './diagnosticsPanel.js'

/** 结构化解法：core 不依赖 @pet/vault，只认这四个字段。 */
export type VaultSeverity = 'ok' | 'warn' | 'error'

export interface VaultDiagnosticLike {
  readonly severity: VaultSeverity
  readonly code: string
  readonly message: string
  readonly kind?: string
  readonly group?: string
  /**
   * 只表示「用户已确认」，用于抑制重复弹窗。
   * 它不降低 severity，也不改变面板等级 —— S1 已把这条写死。
   */
  readonly acknowledged?: boolean
  readonly backend?: string
  /** false 就一定是 error：basic_text / memory 这类后端靠这条暴露。 */
  readonly secure?: boolean
  readonly permission?: string
  /** 只在界面展示；复制导出时不读取。 */
  readonly recoveredFrom?: string
}

export interface VaultDiagnosticsSource {
  diagnose(): Promise<VaultDiagnosticLike>
}

export const VAULT_SECTION = 'vault'
export const VAULT_SECTION_LABEL = '密钥与凭据'

export function toVaultSection(diagnostic: VaultDiagnosticLike): Omit<DiagnosticsSection, 'name'> {
  return {
    ok: diagnostic.severity !== 'error',
    level: diagnostic.severity,
    code: diagnostic.code,
    message: diagnostic.message,
    data: {
      kind: diagnostic.kind ?? 'secure',
      group: diagnostic.group ?? 'credential',
      severity: diagnostic.severity,
      acknowledged: diagnostic.acknowledged ?? false,
      ...(diagnostic.backend === undefined ? {} : { backend: diagnostic.backend }),
      ...(diagnostic.secure === undefined ? {} : { secure: diagnostic.secure }),
      ...(diagnostic.permission === undefined ? {} : { permission: diagnostic.permission }),
      ...(diagnostic.recoveredFrom === undefined ? {} : { recoveredFrom: diagnostic.recoveredFrom })
    }
  }
}

export function toVaultPanelRow(diagnostic: VaultDiagnosticLike): PanelRow {
  const detail = [
    diagnostic.code,
    diagnostic.backend === undefined ? undefined : `backend=${diagnostic.backend}`,
    diagnostic.secure === undefined ? undefined : `secure=${String(diagnostic.secure)}`,
    diagnostic.permission === undefined ? undefined : `permission=${diagnostic.permission}`,
    `severity=${diagnostic.severity}`,
    diagnostic.message,
    diagnostic.acknowledged === true ? '（已确认）' : undefined
  ]
    .filter((part): part is string => part !== undefined)
    .join(' · ')

  return {
    id: VAULT_SECTION,
    label: VAULT_SECTION_LABEL,
    level: diagnostic.severity,
    detail
  }
}

/**
 * 把 S1 的 diagnose() 接进诊断聚合器。
 * 返回注销函数；重复注册同名数据源会覆盖旧来源。
 */
export function registerVaultDiagnostics(diagnostics: Diagnostics, source: VaultDiagnosticsSource): () => void {
  return diagnostics.registerSection(VAULT_SECTION, async () => toVaultSection(await source.diagnose()))
}
