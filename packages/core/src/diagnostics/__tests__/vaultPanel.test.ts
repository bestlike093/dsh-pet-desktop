import { describe, expect, it } from 'vitest'
import { Diagnostics } from '../diagnostics.js'
import { buildPanelView, panelRows } from '../panelView.js'
import { registerVaultDiagnostics, VAULT_SECTION } from '../vaultSection.js'

describe('S3 DoD ③：面板列出 Vault 四项', () => {
  it('backend / secure / permission / severity 都出现在诊断行里', async () => {
    const diagnostics = new Diagnostics({ version: '2.0.0' })
    registerVaultDiagnostics(diagnostics, {
      diagnose: async () => ({
        severity: 'warn',
        code: 'KEY_PERMISSION',
        message: '密钥文件权限过宽',
        backend: 'dpapi',
        secure: true,
        permission: '0644'
      })
    })

    const view = buildPanelView(await diagnostics.collect())
    const row = panelRows(view).find((item) => item.id === VAULT_SECTION)

    expect(row).toBeDefined()
    expect(row?.detail).toContain('backend=dpapi')
    expect(row?.detail).toContain('secure=true')
    expect(row?.detail).toContain('permission=0644')
    expect(row?.detail).toContain('severity=warn')
    expect(row?.level).toBe('warn')
    expect(row?.fixHint.length).toBeGreaterThan(0)
  })

  it('secure=false 一定是 error，不被 acknowledged 降级', async () => {
    const diagnostics = new Diagnostics({ version: '2.0.0' })
    registerVaultDiagnostics(diagnostics, {
      diagnose: async () => ({
        severity: 'error',
        code: 'VAULT_TAMPERED',
        message: '非安全后端',
        backend: 'basic_text',
        secure: false,
        acknowledged: true
      })
    })

    const view = buildPanelView(await diagnostics.collect())
    const row = panelRows(view).find((item) => item.id === VAULT_SECTION)

    expect(row?.level).toBe('error')
    expect(row?.detail).toContain('secure=false')
    expect(row?.detail).toContain('severity=error')
  })
})
