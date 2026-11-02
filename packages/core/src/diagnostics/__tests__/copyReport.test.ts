import { describe, expect, it } from 'vitest'
import { userInfo } from 'node:os'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { buildCopyPayload, redactReport } from '../copyReport.js'
import { buildPanelView } from '../panelView.js'
import type { DiagnosticsSnapshot } from '../diagnostics.js'

function snapshot(sections: DiagnosticsSnapshot['sections']): DiagnosticsSnapshot {
  return {
    version: '2.0.0',
    generatedAt: 1000,
    ok: true,
    bridge: 'connected',
    sections
  }
}

describe('一键复制：持久化输出过两道', () => {
  it('Windows / macOS / Linux 的用户目录名都被脱敏', () => {
    expect(redactReport('C:\\Users\\alice\\AppData\\local')).toBe('C:\\Users\\<user>\\AppData\\local')
    expect(redactReport('/Users/alice/Library/key')).toBe('/Users/<user>/Library/key')
    expect(redactReport('/home/alice/.config/key')).toBe('/home/<user>/.config/key')
    // 反向验证：形态不匹配时不替换。证明上面的断言依赖脱敏逻辑，而不是把 alice 无脑抹掉。
    expect(redactReport('alice')).toBe('alice')
    expect(redactReport('user alice is here')).toContain('alice')
  })

  it('裸用户名不在脱敏范围内（A 方案的已知边界）', () => {
    const username = userInfo().username
    // 记录这个边界，避免以后有人误以为裸名也能被兜住。
    // 报告不输出裸名的责任在数据源头，不在 redactReport。
    expect(redactReport(username)).toBe(username)
  })

  it('数据源若携带本机路径，导出载荷不含当前运行用户名', () => {
    const username = userInfo().username
    const view = buildPanelView(
      snapshot([
        {
          name: 'vault',
          ok: false,
          level: 'error',
          code: 'VAULT_LOCKED',
          data: {
            group: 'security',
            kind: 'credential',
            path: `C:\\Users\\${username}\\AppData\\key.bin`
          }
        }
      ])
    )

    const result = buildCopyPayload(view)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.text).not.toContain(username)
    }
  })

  it('诊断模块不直接读取裸用户名（A 方案的源头约束）', () => {
    // 约定：报告 / 日志 / 导出不输出裸用户名，责任在数据源头。
    // 一旦有人把 userInfo().username 或 %USERNAME% 拼进 data，这条会先红。
    // 路径里出现用户名不受影响 —— 形态匹配会脱掉它。
    const dir = fileURLToPath(new URL('..', import.meta.url))
    const offenders = readdirSync(dir)
      .filter((file) => file.endsWith('.ts'))
      .filter((file) => /userInfo\s*\(|process\.env\.USERNAME/.test(readFileSync(join(dir, file), 'utf8')))

    expect(offenders).toEqual([])
  })

  it('recoveredFrom 只在界面出现，不进复制载荷', () => {
    const view = buildPanelView(
      snapshot([
        {
          name: 'vault',
          ok: true,
          level: 'warn',
          code: 'VAULT_TAMPERED',
          data: {
            group: 'security',
            kind: 'credential',
            recoveredFrom: 'C:\\Users\\alice\\AppData\\key.corrupt-1'
          }
        }
      ])
    )

    const result = buildCopyPayload(view)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.text).not.toContain('corrupt-1')
      expect(result.text).not.toContain('alice')
    }
  })

  it('未登记的 code 拒绝导出，整份不落盘', () => {
    const view = buildPanelView(
      snapshot([{ name: 'broken', ok: false, level: 'error', code: 'NOT_A_REAL_CODE' }])
    )

    const result = buildCopyPayload(view)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toContain('NOT_A_REAL_CODE')
    }
  })

  it('合法 code 正常导出并保留修复建议', () => {
    const view = buildPanelView(
      snapshot([{ name: 'vault', ok: false, level: 'error', code: 'VAULT_LOCKED' }])
    )

    const result = buildCopyPayload(view)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.text).toContain('VAULT_LOCKED')
      expect(result.text).toContain('fix:')
    }
  })
})
