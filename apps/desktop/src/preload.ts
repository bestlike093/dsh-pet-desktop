import type { IpcChannel } from './ipc.js'

export type PreloadInvoke = (channel: IpcChannel, payload?: unknown) => Promise<unknown>

/**
 * 渲染层能看到的全部能力。
 * 每个方法固定绑定一个 channel，调用方无法传入任意通道名。
 */
export interface PreloadApi {
  ask(question: string, options?: readonly string[]): Promise<unknown>
  approve(title: string, risk?: 'low' | 'medium' | 'high'): Promise<unknown>
  reportTask(progress: {
    readonly id: string
    readonly label: string
    readonly ratio: number
    readonly state: 'running' | 'done' | 'failed'
  }): void
  getSettings(): Promise<unknown>
  saveSettings(next: unknown): Promise<unknown>
  setClickThrough(enabled: boolean): Promise<unknown>
  setAlwaysOnTop(enabled: boolean): Promise<unknown>
  move(x: number, y: number): Promise<unknown>
  collectDiagnostics(): Promise<unknown>
  /** 密钥只写不读：渲染层能设置与清除，回显只有掩码。 */
  setSecret(serviceId: string, value: string, field?: string): Promise<unknown>
  getSecretMasked(serviceId: string, field?: string): Promise<unknown>
  /** 只验证 QQ 凭据与网关可达性；不发送消息，也不回传 token。 */
  qqTest(): Promise<unknown>
  /** QQ 通道运行状态：只读，不含凭据。 */
  qqStatus(): Promise<unknown>
  clearSecret(serviceId: string, field?: string): Promise<unknown>
  diagnoseVault(): Promise<unknown>
  /** 备份口令只在调用瞬间出现，不进入设置或本地存储。 */
  exportVault(password: string): Promise<unknown>
  importVault(password: string): Promise<unknown>
  /**
   * 聊天：历史留在主进程内存里，渲染层只发文本、拿结果。
   * 返回结构由主进程决定（ok / reason / reply），这里不假设成功。
   */
  sendChat(text: string): Promise<unknown>
  getChatHistory(): Promise<unknown>
  getChatStatus(): Promise<unknown>
  clearChat(): Promise<unknown>
  openChat(): Promise<unknown>
  closeChat(): Promise<unknown>
  /** 记忆：统计、分页读取、单条删除；清除仍是整份清除。 */
  getMemoryStats(): Promise<unknown>
  listMemory(options?: {
    readonly offset?: number
    readonly limit?: number
    readonly query?: string
    readonly role?: string
    readonly from?: string
    readonly to?: string
  }): Promise<unknown>
  deleteMemory(id: string): Promise<unknown>
  exportMemory(options?: {
    readonly query?: string
    readonly role?: string
    readonly from?: string
    readonly to?: string
  }): Promise<unknown>
  clearMemory(): Promise<unknown>
  /** 启动前体检：只汇总本地状态，不发网络请求、不计费。 */
  getPreflight(): Promise<unknown>
  /** 人格预览：主进程真实拼装结果。 */
  getPersonaPreview(): Promise<unknown>
  /** 语音：自动/手动出声；失败回 ok:false，不抛。 */
  speakVoice(text: string, reason?: 'auto' | 'manual'): Promise<unknown>
  /** 语音服务真实状态：只回 state，人话交给界面翻译。 */
  voiceStatus(): Promise<unknown>
}

export const PRELOAD_METHODS: readonly (keyof PreloadApi)[] = [
  'ask',
  'approve',
  'reportTask',
  'getSettings',
  'saveSettings',
  'setClickThrough',
  'setAlwaysOnTop',
  'move',
  'collectDiagnostics',
  'setSecret',
  'getSecretMasked',
  'qqTest',
  'qqStatus',
  'clearSecret',
  'diagnoseVault',
  'exportVault',
  'importVault',
  'sendChat',
  'getChatHistory',
  'getChatStatus',
  'clearChat',
  'openChat',
  'closeChat',
  'getMemoryStats',
  'listMemory',
  'deleteMemory',
  'exportMemory',
  'clearMemory',
  'getPreflight',
  'getPersonaPreview',
  'speakVoice',
  'voiceStatus'
]

export function createPreloadApi(invoke: PreloadInvoke): PreloadApi {
  return {
    ask: (question, options) => invoke('pet:ask', { question, options }),
    approve: (title, risk = 'low') => invoke('pet:approve', { title, risk }),
    reportTask: (progress) => {
      void invoke('pet:reportTask', progress)
    },
    getSettings: () => invoke('pet:settings:get'),
    saveSettings: (next) => invoke('pet:settings:save', next),
    setClickThrough: (enabled) => invoke('pet:window:setClickThrough', { enabled }),
    setAlwaysOnTop: (enabled) => invoke('pet:window:setAlwaysOnTop', { enabled }),
    move: (x, y) => invoke('pet:window:move', { x, y }),
    collectDiagnostics: () => invoke('pet:diagnostics:collect'),
    // 明文只在 setSecret 的入参里短暂出现，回传一律走掩码。
    setSecret: (serviceId, value, field) => invoke('pet:secrets:set', { serviceId, value, field }),
    getSecretMasked: (serviceId, field) => invoke('pet:secrets:masked', { serviceId, field }),
    qqTest: () => invoke('pet:qq:test'),
    qqStatus: () => invoke('pet:qq:status'),
    clearSecret: (serviceId, field) => invoke('pet:secrets:clear', { serviceId, field }),
    diagnoseVault: () => invoke('pet:vault:diagnose'),
    exportVault: (password) => invoke('pet:vault:export', { password }),
    importVault: (password) => invoke('pet:vault:import', { password }),
    // 聊天：失败也是正常返回（ok:false + reason），不走 reject。
    sendChat: (text) => invoke('pet:chat:send', { text }),
    getChatHistory: () => invoke('pet:chat:history'),
    getChatStatus: () => invoke('pet:chat:status'),
    clearChat: () => invoke('pet:chat:clear'),
    openChat: () => invoke('pet:chat:open'),
    closeChat: () => invoke('pet:chat:close'),
    // 记忆：统计与分页读取；单条删除按 id 走，清空仍是整份清空。
    getMemoryStats: () => invoke('pet:memory:stats'),
    listMemory: (options) => invoke('pet:memory:list', options),
    deleteMemory: (id) => invoke('pet:memory:delete', { id }),
    exportMemory: (options) => invoke('pet:memory:export', options),
    clearMemory: () => invoke('pet:memory:clear'),
    // 启动前体检：一次拿齐模型、密钥、语音配置、磁盘与 Vault 状态。
    getPreflight: () => invoke('pet:preflight'),
    getPersonaPreview: () => invoke('pet:persona:preview'),
    // 语音：manual 表示点小喇叭，不受「只在小喇叭被点时」限制。
    speakVoice: (text, reason = 'auto') => invoke('pet:voice:speak', { text, reason }),
    voiceStatus: () => invoke('pet:voice:status')
  }
}
