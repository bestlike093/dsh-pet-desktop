// 诊断快照：只读主进程状态，不写盘、不改设置、不主动 send。
// 依赖全部由 electron/main.mjs 注入，本模块不反向 import 主进程单例。
type AnyRecord = Record<string, any>

export interface DiagnosticsDeps {
  registerChannel: (channel: string, listener: (...args: any[]) => unknown) => void
  getAppVersion: () => string
  listIpcChannels: () => readonly string[]
  getRegisteredChannels: () => string[]
  getPendingDecisionIds: () => unknown
  getSettings: () => AnyRecord
  getMediaRoot: () => string
  modelStore: AnyRecord
  getQq: () => AnyRecord | null
  getVault: () => AnyRecord | null
  getLegacyKeyMigrationWarning: () => unknown
}

export function registerDiagnosticsChannels(deps: DiagnosticsDeps): void {
  const register = deps.registerChannel

  register('pet:diagnostics:collect', async () => {
    const qq = deps.getQq()
    const qqHealth =
      qq === null
        ? { ok: false, code: 'CHANNEL_NOT_CONFIGURED', message: 'QQ 凭据未配置' }
        : await qq.health()

    const vault = deps.getVault()

    return {
      app: {
        version: deps.getAppVersion(),
        electron: process.versions.electron,
        node: process.versions.node
      },
      platform: process.platform,
      // 白名单与真实注册面分开报：只报一份时，漏登记根本看不出来。
      ipcChannels: {
        listed: deps.listIpcChannels(),
        registered: deps.getRegisteredChannels()
      },
      pendingDecisions: deps.getPendingDecisionIds(),
      channels: {
        local: { ok: true },
        qq: qqHealth
      },
      // 新增的用户可见项都要能在诊断里看到，否则「看不见模型」时无从判断。
      media: {
        root: deps.getMediaRoot(),
        activeId: deps.getSettings().live2dModelId,
        models: await deps.modelStore.list().catch(() => [])
      },
      vault:
        vault === null
          ? {
              ok: false,
              code: 'VAULT_UNAVAILABLE',
              legacyKeyMigration: deps.getLegacyKeyMigrationWarning()
            }
          : await vault.diagnose().then((diagnostic: AnyRecord) => ({
              ok: true,
              ...diagnostic,
              legacyKeyMigration: deps.getLegacyKeyMigrationWarning()
            }))
    }
  })
}
