import { describe, expect, it } from 'vitest'
import { Diagnostics } from '../diagnostics.js'
import { buildDiagnosticsPanel } from '../diagnosticsPanel.js'
import { registerVaultDiagnostics, toVaultPanelRow, toVaultSection } from '../vaultSection.js'

describe('S3 DoD ③：诊断面板能列出 S1 的 Vault 检查项', () => {
  it('error 保留 severity，面板同步标红', async () => {
    const diagnostics = new Diagnostics({ version: '2.0.0', now: () => 1 })
    registerVaultDiagnostics(diagnostics, {
      diagnose: async () => ({
        severity: 'error',
        code: 'KEY_BACKEND_INSECURE',
        message: '密钥后端不安全',
        backend: 'plaintext-dir'
      })
    })

    const snapshot = await diagnostics.collect()
    const section = snapshot.sections[0]

    expect(section?.name).toBe('vault')
    expect(section?.ok).toBe(false)
    expect(section?.level).toBe('error')
    expect(section?.code).toBe('KEY_BACKEND_INSECURE')
    expect(snapshot.ok).toBe(false)

    const panel = buildDiagnosticsPanel(snapshot)
    expect(panel.rows[0]?.level).toBe('error')
    expect(panel.rows[0]?.detail).toContain('KEY_BACKEND_INSECURE')
    expect(panel.ok).toBe(false)
  })

  it('ok 时面板整体通过，且带上 backend', async () => {
    const diagnostics = new Diagnostics({ version: '2.0.0', now: () => 1 })
    registerVaultDiagnostics(diagnostics, {
      diagnose: async () => ({
        severity: 'ok',
        code: 'OK',
        message: '系统后端可用',
        backend: 'system-keychain'
      })
    })

    const snapshot = await diagnostics.collect()
    const panel = buildDiagnosticsPanel(snapshot, { vault: '密钥与凭据' })

    expect(panel.rows[0]?.label).toBe('密钥与凭据')
    expect(panel.rows[0]?.level).toBe('ok')
    expect(panel.rows[0]?.detail).toContain('backend=system-keychain')
    expect(panel.ok).toBe(true)
  })

  it('acknowledged 只影响文案，不降低 severity', () => {
    const section = toVaultSection({
      severity: 'error',
      code: 'KEY_BACKEND_INSECURE',
      message: '明文后端',
      acknowledged: true
    })
    const row = toVaultPanelRow({
      severity: 'error',
      code: 'KEY_BACKEND_INSECURE',
      message: '明文后端',
      acknowledged: true
    })

    expect(section.level).toBe('error')
    expect(section.data).toMatchObject({ acknowledged: true, group: 'credential', kind: 'secure' })
    expect(row.level).toBe('error')
    expect(row.detail).toContain('（已确认）')
  })

  it('basic_text 形状：secure=false 必须落 error，四项字段齐全', () => {
    const diagnostic = {
      severity: 'error' as const,
      code: 'KEY_BACKEND_INSECURE',
      message: '密钥后端不提供真实保护（secure=false）',
      backend: 'safeStorage',
      secure: false,
      permission: 'ok',
      acknowledged: true
    }

    const section = toVaultSection(diagnostic)
    const row = toVaultPanelRow(diagnostic)

    expect(section.level).toBe('error')
    expect(section.ok).toBe(false)
    expect(section.data).toMatchObject({
      backend: 'safeStorage',
      secure: false,
      permission: 'ok',
      severity: 'error'
    })
    expect(row.detail).toContain('backend=safeStorage')
    expect(row.detail).toContain('secure=false')
    expect(row.detail).toContain('permission=ok')
    expect(row.detail).toContain('severity=error')
    // 用户确认只抑制弹窗，不允许把 error 降成 warn
    expect(row.level).toBe('error')
  })

  it('文件权限异常同样保持 error', () => {
    const section = toVaultSection({
      severity: 'error',
      code: 'KEY_FILE_PERMISSION',
      message: '密钥文件权限异常：too-open',
      backend: 'safeStorage',
      secure: true,
      permission: 'too-open'
    })

    expect(section.level).toBe('error')
    expect(section.data).toMatchObject({ permission: 'too-open', secure: true })
  })

  it('diagnose 抛错只污染 vault 一节，其他数据源照常输出', async () => {
    const diagnostics = new Diagnostics({ version: '2.0.0', now: () => 1 })
    diagnostics.register('modules', () => 'none')
    registerVaultDiagnostics(diagnostics, {
      diagnose: async () => {
        throw new Error('密钥文件读失败')
      }
    })

    const snapshot = await diagnostics.collect()

    expect(snapshot.sections).toHaveLength(2)
    expect(snapshot.sections[0]?.name).toBe('modules')
    expect(snapshot.sections[0]?.ok).toBe(true)
    expect(snapshot.sections[1]?.name).toBe('vault')
    expect(snapshot.sections[1]?.ok).toBe(false)
    expect(snapshot.sections[1]?.level).toBe('error')
    expect(snapshot.ok).toBe(false)
  })
})
