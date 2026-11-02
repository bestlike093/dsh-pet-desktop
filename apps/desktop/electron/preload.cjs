// 渲染进程唯一入口：只暴露固定方法，不暴露 ipcRenderer 本身。
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('pet', {
  getSettings: () => ipcRenderer.invoke('pet:settings:get'),
  saveSettings: (settings) => ipcRenderer.invoke('pet:settings:save', settings),
  setClickThrough: (enabled) => ipcRenderer.invoke('pet:window:setClickThrough', enabled),
  setAlwaysOnTop: (enabled) => ipcRenderer.invoke('pet:window:setAlwaysOnTop', enabled),
  move: (x, y) => ipcRenderer.invoke('pet:window:move', { x, y }),
  // 一键归位：主进程把窗口贴到主屏右下角，渲染侧不用自己算多屏坐标。
  dockToBottomRight: () => ipcRenderer.invoke('pet:window:move', { dock: 'bottom-right' }),
  // 拖拽：渲染侧只发开始/结束，位置跟随由主进程读光标完成。
  dragStart: () => ipcRenderer.invoke('pet:window:dragStart'),
  dragEnd: (velocity) => ipcRenderer.invoke('pet:window:dragEnd', velocity),
  diagnostics: () => ipcRenderer.invoke('pet:diagnostics:collect'),
  // Live2D 模型库：列表 / 当前生效模型 / 导入（zip 或文件夹）/ 切换 / 打开目录。
  // 导入会弹系统选择框，选完由主进程解压并校验，返回带 pet-media URL 的模型。
  listModels: () => ipcRenderer.invoke('pet:models:list'),
  getActiveModel: () => ipcRenderer.invoke('pet:models:active'),
  importModel: (kind) => ipcRenderer.invoke('pet:models:import', { kind }),
  setActiveModel: (modelId) => ipcRenderer.invoke('pet:models:setActive', modelId),
  openModelsFolder: () => ipcRenderer.invoke('pet:models:openFolder'),
  // 素材包：字体 / 图标 / 气泡 / 表情，统一走 zip 导入，存 userData/packs。
  // 返回的每个文件都带 pet-media://pack/<id>/<相对路径>，渲染侧拿不到绝对路径。
  listPacks: () => ipcRenderer.invoke('pet:packs:list'),
  importPack: () => ipcRenderer.invoke('pet:packs:import'),
  removePack: (packId) => ipcRenderer.invoke('pet:packs:remove', packId),
  setPackEnabled: (packId, enabled) =>
    ipcRenderer.invoke('pet:packs:setEnabled', packId, enabled === true),
  // 余额：主进程拿 Vault 里的 Key 查一次，明文不回渲染侧。
  queryBalance: () => ipcRenderer.invoke('pet:balance:query'),
  // 密钥：明文只在 setSecret 的入参里出现一次，读回来一律掩码。
  setSecret: (serviceId, value, field) =>
    ipcRenderer.invoke('pet:secrets:set', { serviceId, value, field }),
  getSecretMasked: (serviceId, field) =>
    ipcRenderer.invoke('pet:secrets:masked', { serviceId, field }),
  clearSecret: (serviceId, field) =>
    ipcRenderer.invoke('pet:secrets:clear', { serviceId, field }),
  qqTest: () => ipcRenderer.invoke('pet:qq:test'),
  qqStatus: () => ipcRenderer.invoke('pet:qq:status'),
  // 语音：气泡出字时来要声音，主进程合完把音频交回来，自己负责播放。
  // 失败一律返回 ok:false，渲染侧静默跳过——没声音不该影响出字。
  // reason=manual 表示点小喇叭，不受「只在小喇叭被点时」这条设置挡。
  speakVoice: (text, reason = 'auto') => ipcRenderer.invoke('pet:voice:speak', { text, reason }),
  // 语音服务真实状态：只回 state，人话由界面按语言翻译。
  voiceStatus: () => ipcRenderer.invoke('pet:voice:status'),
  pickRefAudio: () => ipcRenderer.invoke('pet:voice:pickRefAudio'),
  testLlm: () => ipcRenderer.invoke('pet:llm:test'),
  runSync: (action) => ipcRenderer.invoke('pet:sync:run', { action }),
  getSyncInfo: () => ipcRenderer.invoke('pet:sync:info'),
  chooseSyncDir: () => ipcRenderer.invoke('pet:sync:chooseDir'),
  // 同步口令：只回是否配置成功，不回明文；状态接口只给掩码。
  setSyncPassphrase: (passphrase) => ipcRenderer.invoke('pet:sync:setPassphrase', { passphrase }),
  clearSyncPassphrase: () => ipcRenderer.invoke('pet:sync:clearPassphrase'),
  getSyncPassphraseStatus: () => ipcRenderer.invoke('pet:sync:passphraseStatus'),
  // 聊天：历史只在主进程内存里；失败原因是结构化字段，界面自己决定怎么说。
  sendChat: (text) => ipcRenderer.invoke('pet:chat:send', { text }),
  getChatHistory: () => ipcRenderer.invoke('pet:chat:history'),
  getChatStatus: () => ipcRenderer.invoke('pet:chat:status'),
  clearChat: () => ipcRenderer.invoke('pet:chat:clear'),
  exportChat: () => ipcRenderer.invoke('pet:chat:export'),
  openChat: () => ipcRenderer.invoke('pet:chat:open'),
  closeChat: () => ipcRenderer.invoke('pet:chat:close'),
  // 记忆：统计与分页读取；单条删除按 id 走，清空仍是整份清空。
  getMemoryStats: () => ipcRenderer.invoke('pet:memory:stats'),
  listMemory: (options) => ipcRenderer.invoke('pet:memory:list', options),
  deleteMemory: (id) => ipcRenderer.invoke('pet:memory:delete', { id }),
  exportMemory: (options) => ipcRenderer.invoke('pet:memory:export', options),
  clearMemory: () => ipcRenderer.invoke('pet:memory:clear'),
  // 启动前体检：一次拿齐模型、密钥、语音配置、磁盘与 Vault 状态。
  preflight: () => ipcRenderer.invoke('pet:preflight'),
  // 人格预览：主进程真实拼装结果，供设置页展示。
  getPersonaPreview: () => ipcRenderer.invoke('pet:persona:preview'),
  // 右键桌宠：交给主进程弹原生菜单，渲染侧不自己画浮层。
  openContextMenu: (payload) => ipcRenderer.invoke('pet:menu:context', payload),
  // 独立设置窗：打开 / 关闭 / 应用尺寸 / 读实时状态。
  openSettings: (panel) => ipcRenderer.invoke('pet:settings:open', { panel }),
  closeSettings: () => ipcRenderer.invoke('pet:settings:close'),
  applyWindowSize: () => ipcRenderer.invoke('pet:window:applySize'),
  getWindowSize: () => ipcRenderer.invoke('pet:window:getSize'),
  getRenderInfo: () => ipcRenderer.invoke('pet:render:info'),
  // 主窗口把渲染侧状态报给主进程，供设置窗读取诊断。
  reportRenderInfo: (info) => ipcRenderer.invoke('pet:render:report', info),
  // 主动说话：结合时间 / 天气 / 记忆 / 心情生成一句；失败时主进程会给本地短句。
  speak: (reason) => ipcRenderer.invoke('pet:presence:speak', reason),
  // 加密仓库自检：只回状态码与计数，不回密钥材料。
  vaultDiagnose: () => ipcRenderer.invoke('pet:vault:diagnose'),
  // 备份：口令只在调用瞬间传给主进程，不落渲染侧存储。
  vaultExport: (password) => ipcRenderer.invoke('pet:vault:export', { password }),
  // 一键备份：目录与保留份数走独立小配置，口令仍只在这次调用里出现。
  backupConfig: () => ipcRenderer.invoke('pet:backup:getConfig'),
  backupChooseDir: () => ipcRenderer.invoke('pet:backup:chooseDir'),
  backupSetKeep: (keep) => ipcRenderer.invoke('pet:backup:setKeep', { keep }),
  backupRun: (password) => ipcRenderer.invoke('pet:backup:run', { password }),
  // 自动备份：开启时若传了口令，主进程用系统密钥加密保存，渲染侧拿不到明文。
  backupSetAuto: (intervalDays, password) =>
    ipcRenderer.invoke('pet:backup:setAuto', { intervalDays, password }),
  backupFindLatest: () => ipcRenderer.invoke('pet:backup:findLatest'),
  vaultImport: (password) => ipcRenderer.invoke('pet:vault:import', { password }),
  // 轮换数据密钥：新写入换新钥，旧数据仍按原 keyId 可读。
  vaultRotate: () => ipcRenderer.invoke('pet:vault:rotate'),
  // 每日巡视与反思：手动触发一次，返回真实结果（没有数据也会说明原因）。
  dailyRun: () => ipcRenderer.invoke('pet:daily:run'),
  dailyLast: () => ipcRenderer.invoke('pet:daily:last'),
  reflectionRun: () => ipcRenderer.invoke('pet:reflection:run'),
  // 能力中心：打开独立窗口；猜拳三动作共用一条通道。
  openAbilityCenter: () => ipcRenderer.invoke('pet:ability:open'),
  rps: (action, choice) => ipcRenderer.invoke('pet:game:rps', { action, choice }),
  // 游戏日常：检测、读/存排班、dry-run 预览。真实执行本轮没有开。
  gameDetect: () => ipcRenderer.invoke('pet:game:detect'),
  gameScheduleGet: () => ipcRenderer.invoke('pet:game:schedule:get'),
  gameScheduleSave: (config) => ipcRenderer.invoke('pet:game:schedule:save', config),
  gameDryRun: (config) => ipcRenderer.invoke('pet:game:dry-run', config),
  // 随包素材：只回名称与 pet-media 地址，渲染侧拿不到磁盘路径。
  listAssets: () => ipcRenderer.invoke('pet:assets:list'),
  // 桌面状态条：先取一次快照，之后由主进程按 3 秒 / 6 秒两拍推送。
  systemStats: () => ipcRenderer.invoke('pet:system:stats'),
  // 心情：主进程按时间与对话间隔算出来的真实状态，只回标签与等级。
  presenceMood: () => ipcRenderer.invoke('pet:presence:mood'),
  onSystemStats: (callback) => {
    const handler = (_event, stats) => callback(stats)
    ipcRenderer.on('pet:system:stats', handler)
    return () => ipcRenderer.removeListener('pet:system:stats', handler)
  },
  // 主进程主动说一句（每日巡视小结）。事件通道，不走 invoke 白名单。
  onBubble: (callback) => {
    const handler = (_event, payload) => callback(payload)
    ipcRenderer.on('pet:bubble', handler)
    return () => ipcRenderer.removeListener('pet:bubble', handler)
  },
  // 余额气泡的「知道了」：点一下才把 ack 从 shown 升到 confirmed。
  ackBalance: (segment) => ipcRenderer.invoke('pet:balance:ack', segment),
  // 设置保存后主进程广播全量设置，主界面据此即时更新气泡 / HUD，不必重启。
  onSettingsChanged: (callback) => {
    const handler = (_event, next) => callback(next)
    ipcRenderer.on('pet:settings:changed', handler)
    return () => ipcRenderer.removeListener('pet:settings:changed', handler)
  },
  // 启动时密钥环重建/隔离只提示一次；返回解绑函数，和生命周期事件同约定。
  onVaultNotice: (callback) => {
    const handler = (_event, notice) => callback(notice)
    ipcRenderer.on('pet:vault:notice', handler)
    return () => ipcRenderer.removeListener('pet:vault:notice', handler)
  },
  ask: (request) => ipcRenderer.invoke('pet:ask', request),
  approve: (id, action, answer) => ipcRenderer.invoke('pet:approve', { id, action, answer }),
  reportTask: (task) => ipcRenderer.invoke('pet:reportTask', task),
  // 能力中心要求设置窗切到某面板（例如「记忆」）。
  onSettingsPanel: (callback) => {
    const handler = (_event, panel) => callback(panel)
    ipcRenderer.on('pet:settings:panel', handler)
    return () => ipcRenderer.removeListener('pet:settings:panel', handler)
  },
  // 托盘「设置」→ 渲染层把面板叫回来（C-84 后面板默认收起，需要外部入口）。
  onShowSettings: (handler) => {
    ipcRenderer.on('pet:show-settings', handler)
    return () => ipcRenderer.removeListener('pet:show-settings', handler)
  },
  onDecision: (callback) => {
    const handler = (_event, outcome) => callback(outcome)
    ipcRenderer.on('pet:decision', handler)
    return () => ipcRenderer.removeListener('pet:decision', handler)
  },
  // 主进程广播的窗口生命周期。返回解绑函数，渲染侧销毁时必须调用，
  // 否则换肤 / 重建窗口会累积监听器。
  onLifecycle: (callback) => {
    const handler = (_event, state) => callback(state)
    ipcRenderer.on('pet:lifecycle', handler)
    return () => ipcRenderer.removeListener('pet:lifecycle', handler)
  }
})
