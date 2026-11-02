import type { EmotionTag, ProfileName } from './model.js'

export type UiMode = 'pet' | 'card'
export type AskHandling = 'pet-all' | 'pet-single' | 'both' | 'web'

export interface WindowSettings {
  readonly x?: number
  readonly y?: number
  readonly height?: number
  readonly scale: number
  readonly alwaysOnTop: boolean
  readonly edgeSnap: boolean
  /** 吸附判定距离（逻辑像素），4..64。 */
  readonly edgeSnapDistance: number
}

export interface BubbleSettings {
  readonly mode: 'rotate' | 'info' | 'talk' | 'today' | 'balance'
  readonly fontSize: number
  readonly radius: number
  readonly alpha: number
  /** 气泡最大宽度（逻辑像素）。0 表示跟随窗口宽度。 */
  readonly width: number
  /** 气泡最大高度，超出在气泡内滚动。0 表示不限制。 */
  readonly height: number
  /** 气泡内边距，四周统一。 */
  readonly padding: number
  /** 行高倍数，1.2..2.4。 */
  readonly lineHeight: number
  /** 字体族；空串表示用内置字体栈，也可以是 pack:<id>:<file> 指向导入的字体。 */
  readonly fontFamily: string
  /** 表情贴纸 / 状态栏头像的边长（逻辑像素）。 */
  readonly stickerSize: number
  /** 气泡底图；空串表示用纯 CSS 外观，pack:<id>:<file> 表示九宫格底图。 */
  readonly background: string
  /** 九宫格切片像素；底图宽或高小于 2 倍切片时会被渲染侧拒绝。 */
  readonly backgroundSlice: number
}

/** 托盘与任务栏图标来源：空串 = 内置 Cyrene 素材，pack:<id>:<file> = 用户素材包。 */
export interface IconSettings {
  readonly tray: string
  readonly app: string
}

/** 气泡旁贴纸：空串 = 关闭，pack:<id>:<file> = 包内表情。 */
export interface StickerSettings {
  readonly source: string
}

export interface ModuleToggle {
  readonly enabled: boolean
  readonly permissions: readonly string[]
}

export interface ThemeSettings {
  readonly preset: string
  readonly custom: Readonly<Record<string, string>>
}

export type QqTransport = 'gateway' | 'webhook'

/** QQ 机器人设置。凭据本体在 Vault，这里只存 appId、主人名单与传输方式。 */
export interface QqChannelConfig {
  readonly enabled: boolean
  readonly transport: QqTransport
  readonly appId: string
  /** AppSecret 在 Vault 中的引用；明文不进 settings.json。 */
  readonly credentialRef: string
  /** 允许拍板的主人 openid；空数组时远程拍板一律拒绝。 */
  readonly ownerOpenIds: readonly string[]
  /** 可选投递目标；空串表示回复最近一次入站会话。 */
  readonly targetOpenId: string
  /** webhook 模式下的 Ed25519 公钥；gateway 模式不用。 */
  readonly publicKey: string
  /** webhook 模式监听端口；默认只监听本机。 */
  readonly webhookPort: number
}

export interface ChannelsConfig {
  readonly qq: QqChannelConfig
}

/** 语音什么时候允许开口。 */
export type VoiceTrigger = 'every' | 'proactive' | 'manual'

export interface QuietHours {
  readonly enabled: boolean
  /** 24 小时制 HH:MM，例如 '22:00'。 */
  readonly start: string
  /** 24 小时制 HH:MM，例如 '08:00'。跨零点时 start > end。 */
  readonly end: string
}

/** 语音走哪条合成路线。local 不出网、不计费；cloud 要 Key。 */
export type VoiceProvider = 'local' | 'cloud'

export interface CloudVoiceSettings {
  /** 云端合成接口完整地址；留空视为没配，不会发请求。 */
  readonly baseUrl: string
  /** 音色标识，由服务方定义；留空用服务默认音色。 */
  readonly voice: string
}

export interface VoiceSettings {
  /** 默认关闭：第一次打开不出声，避免吓到使用者。 */
  readonly enabled: boolean
  /** every=每条都念，proactive=只在主动搭话时念，manual=只在小喇叭被点时念。 */
  readonly trigger: VoiceTrigger
  readonly quietHours: QuietHours
  /** 默认 local：先不把文本发出去。 */
  readonly provider: VoiceProvider
  /**
   * 本地合成地址，只接受回环。
   * 默认对齐 IndexTTS v2 / GPT-SoVITS 的 9880。
   */
  readonly localUrl: string
  /**
   * 本地接口协议。默认 gpt-sovits——本机 IndexTTS / GPT-SoVITS 服务都认这套参数；
   * 换成自建的通用接口时改回 generic。
   */
  readonly localProtocol: VoiceLocalProtocol
  /** GPT-SoVITS 的参考音频，填服务端本机路径；留空时本地合成不会发请求。 */
  readonly refAudioPath: string
  /** 参考音频与文本的语言代码，默认 zh。 */
  readonly promptLang: string
  readonly cloud: CloudVoiceSettings
  /** 播放音量，0..1。与服务端参数无关，只作用于本机播放。 */
  readonly volume: number
  /** 单条朗读的字数上限，超出截断。防止一整段长文被念完。 */
  readonly maxChars: number
  /** 两次自动开口之间的最小间隔（秒），0 表示不限制。 */
  readonly minIntervalSeconds: number
}

export type VoiceLocalProtocol = 'generic' | 'gpt-sovits'

/** 界面语言。只影响界面文案，不改角色说话的语言。 */
export type Locale = 'zh-CN' | 'en-US'

export interface MemorySettings {
  /** 默认关闭：开启后才开始记录对话，装完不会悄悄存东西。 */
  readonly enabled: boolean
  /** 最多保留多少条长期记忆，超出按权重淘汰。 */
  readonly maxItems: number
  /** 每多少轮对话触发一次摘要压缩。 */
  readonly summarizeEvery: number
}

export interface ChatSettings {
  /** 默认关闭：要用户自己填 Key 才能开。 */
  readonly enabled: boolean
  /**
   * 服务商。当前只支持 deepseek：端点写死在主进程，渲染侧无法指定地址。
   * 自定义端点不开放，避免把 Key 发到任意服务器。
   */
  readonly provider: 'deepseek'
  readonly model: string
  readonly maxTokens: number
  readonly temperature: number
  /** 每次请求带多少条历史，0 表示不带。 */
  readonly historyLimit: number
}

export interface PersonaSettings {
  /** 是否把人格提示词注入每次对话。 */
  readonly enabled: boolean
  /** 追加在基础人格之后的风格说明，留空表示只用默认。 */
  readonly extraPrompt: string
}

/** 情绪余波：只影响表现层，不进入模型上下文。默认关闭。 */
export interface AfterglowSettings {
  readonly enabled: boolean
  /** 半衰期，单位分钟，5..720。 */
  readonly halfLifeMinutes: number
}

/** 表情表达实验：off / experiment / control 三组对照。 */
export interface ExpressionSettings {
  readonly group: 'off' | 'experiment' | 'control'
}

export interface EmotionSettings {
  readonly afterglow: AfterglowSettings
  readonly expression: ExpressionSettings
  /** 需求状态只调整主动开口排序，默认关闭。 */
  readonly needs: { readonly enabled: boolean }
}

/** 一项按时刻触发的陪伴任务。 */
export interface CareSchedule {
  readonly enabled: boolean
  /** 24 小时制 HH:MM。 */
  readonly at: string
}

export interface CareSettings {
  /** 每日终盘巡视：复盘当天表现，产出次日的调整建议。 */
  readonly dailyReview: CareSchedule
  /** 每日逐案复盘：逐条判断前一天的对话问题。 */
  readonly caseReview: CareSchedule
  /** 人格标准化问卷：从人格文本归纳表达风格。 */
  readonly questionnaire: { readonly enabled: boolean }
  /** 需求强化：按需求层级调整主动开口的排序。 */
  readonly maslow: { readonly enabled: boolean }
  /** 每日 token 预算上限，0 表示不限。 */
  readonly dailyTokenBudget: number
}

export interface CompanionSettings {
  readonly memory: MemorySettings
  readonly chat: ChatSettings
  readonly persona: PersonaSettings
  readonly emotion: EmotionSettings
  readonly care: CareSettings
}


/**
 * 主动台词：把「此刻」交给模型，换回一句能直接放进气泡的话。
 *
 * 默认关闭：打开后才会访问天气接口和聊天模型，关掉时气泡只用本地台词池。
 */
export interface PresenceSettings {
  readonly aiEnabled: boolean
  /** 自动开口间隔，分钟。越短越费 token。 */
  readonly intervalMinutes: number
  /** 天气城市。不认识的名字按默认城市取，不阻断说话。 */
  readonly city: string
  /** 关掉后不发起任何天气请求。 */
  readonly useWeather: boolean
  /** 夜间不扰：时段与处理方式都由使用者自己定。 */
  readonly quiet: QuietHoursSettings
}

/**
 * 夜间不扰的时段与方式。
 *
 * 时间按本机时区算，支持跨零点（比如 23:00–08:00）。
 * 三种方式对应三种不同的取舍，默认「只关搭话、保留定时提醒」。
 */
export interface QuietHoursSettings {
  readonly enabled: boolean
  /** 开始时间 HH:mm，含这一分钟。 */
  readonly from: string
  /** 结束时间 HH:mm，不含这一分钟。 */
  readonly to: string
  /**
   * silent     —— 这一时段不发任何主动气泡，日报也不发
   * reduce     —— 保留主动气泡，间隔拉长到 3 倍
   * urgentOnly —— 只关搭话，保留使用者自己设定的定时提醒（日报）
   */
  readonly mode: 'silent' | 'reduce' | 'urgentOnly'
  /** 时段内顺便隐藏状态栏；只影响显示，不改 showHud 本身。 */
  readonly hideHud: boolean
}

/** 余额监控：开关在 modules['builtin.balance']，这里只放阈值与轮询间隔。 */
export interface BalanceSettings {
  /** 低额阈值；balance <= threshold 时进入告警判定。 */
  readonly threshold: number
  /** 轮询间隔，分钟；1..1440。 */
  readonly intervalMinutes: number
}

/** v2 配置全量。任何新增用户可见项都必须同时进 schema、迁移器、诊断项。 */
export interface SettingsV2 {
  readonly schemaVersion: 2
  readonly nickname: string
  /** 首次引导是否走完。false 时启动后弹引导窗；中途关掉也算没走完。 */
  readonly onboarded: boolean
  readonly uiMode: UiMode
  readonly renderMode: 'embedded' | 'standalone' | 'fixed:card' | 'headless'
  readonly profile: ProfileName
  readonly window: WindowSettings
  readonly bubble: BubbleSettings
  /** 托盘 / 任务栏图标来源，默认内置。 */
  readonly icon: IconSettings
  /** 气泡旁贴纸来源，默认关闭。 */
  readonly sticker: StickerSettings
  readonly askHandling: AskHandling
  readonly askEveryMinutes: number
  readonly poseEverySeconds: number
  readonly soundLevel: number
  readonly voice: VoiceSettings
  /** 界面语言。默认简体中文。 */
  readonly locale: Locale
  /** 陪伴相关：记忆、聊天、人格、陪伴任务。全部默认关闭。 */
  readonly companion: CompanionSettings
  /** 主动台词：默认关，关着时不发任何外部请求。 */
  readonly presence: PresenceSettings
  /** 余额监控参数；总开关仍由 modules['builtin.balance'].enabled 决定。 */
  readonly balance: BalanceSettings
  readonly showHud: boolean
  /** 状态栏显示的名字；空串在迁移与渲染时回落「昔涟」。 */
  readonly hudName: string
  readonly hudDetail: 'full' | 'simple' | 'simple2'
  readonly hudAlpha: number
  /** 状态栏整体缩放，1 = 默认；只改 HUD 自身，不动窗口尺寸。 */
  readonly hudScale: number
  /** 状态栏里的字体与图标缩放，1 = 默认。 */
  readonly hudFontScale: number
  readonly channels: ChannelsConfig
  readonly theme: ThemeSettings
  readonly modules: Readonly<Record<string, ModuleToggle>>
  readonly defaultEmotion: EmotionTag
  /**
   * 当前使用的 Live2D 模型 id（models 目录下的子目录名），空串表示还没导入。
   * 模型文件本身不进仓库也不进安装包，由使用者从作者处自行下载后导入。
   */
  readonly live2dModelId: string
}

export const DEFAULT_SETTINGS: SettingsV2 = {
  schemaVersion: 2,
  // 默认留空：昵称由使用者自己填，安装包里不带任何具体人的名字。
  nickname: '',
  onboarded: false,
  uiMode: 'pet',
  renderMode: 'embedded',
  profile: 'vertical',
  window: { scale: 0.7, alwaysOnTop: true, edgeSnap: true, edgeSnapDistance: 12 },
  bubble: {
    mode: 'rotate',
    fontSize: 14.5,
    radius: 10,
    alpha: 0.92,
    // 300 宽在 340 左右的桌宠窗口里留出两侧呼吸位，长句自动折行。
    width: 300,
    height: 200,
    padding: 14,
    lineHeight: 1.5,
    // 空串 = 用内置字体栈，跟着系统语言走。
    fontFamily: '',
    stickerSize: 64,
    // 空串 = 不加底图，保持纯 CSS 外观。
    background: '',
    backgroundSlice: 12
  },
  icon: { tray: '', app: '' },
  sticker: { source: '' },
  askHandling: 'pet-all',
  askEveryMinutes: 0,
  poseEverySeconds: 60,
  soundLevel: 0.5,
  voice: {
    enabled: false,
    trigger: 'proactive',
    quietHours: { enabled: true, start: '22:00', end: '08:00' },
    provider: 'local',
    // 与本机 IndexTTS v2 服务一致；也兼容 GPT-SoVITS 的默认端口。
    localUrl: 'http://127.0.0.1:9880',
    // 本机服务按 GPT-SoVITS 协议收参数，通用接口才需要改成 generic。
    localProtocol: 'gpt-sovits',
    // 参考音频要使用者自己指定，空着时本地合成会被跳过而不是报错。
    refAudioPath: '',
    promptLang: 'zh',
    cloud: { baseUrl: '', voice: '' },
    volume: 1,
    // 一条气泡话通常几十字，超过就不念了，避免长段独白。
    maxChars: 60,
    // 自动开口之间至少隔 8 秒，防止连续刷屏。
    minIntervalSeconds: 8
  },
  locale: 'zh-CN',
  companion: {
    // 记忆、聊天都默认关：不填 Key 不出网，不主动记录。
    memory: { enabled: false, maxItems: 500, summarizeEvery: 8 },
    chat: {
      enabled: false,
      provider: 'deepseek',
      model: 'deepseek-chat',
      maxTokens: 800,
      temperature: 0.8,
      historyLimit: 10
    },
    persona: { enabled: true, extraPrompt: '' },
    emotion: {
      // 余波与需求都是表现层近似：默认关，开了也只影响本机表现。
      afterglow: { enabled: false, halfLifeMinutes: 30 },
      expression: { group: 'off' },
      needs: { enabled: false }
    },
    care: {
      // 陪伴任务全部默认关，开启后会按 dailyTokenBudget 限流。
      dailyReview: { enabled: false, at: '22:30' },
      caseReview: { enabled: false, at: '23:00' },
      questionnaire: { enabled: false },
      maslow: { enabled: false },
      dailyTokenBudget: 20_000
    }
  },
  presence: {
    // 关着时不请求天气、不请求模型，气泡只用本地台词池。
    aiEnabled: false,
    intervalMinutes: 12,
    // 留空 = 用 presence.mjs 里的默认城市，不在配置里替使用者选地方。
    city: '',
    useWeather: true,
    // 默认关闭；打开后默认 23:00–08:00 只关搭话、保留定时提醒。
    quiet: { enabled: false, from: '23:00', to: '08:00', mode: 'urgentOnly', hideHud: false }
  },
  // 余额监控默认关；参数先给保守值，打开模块后才生效。
  balance: { threshold: 20, intervalMinutes: 30 },
  showHud: false,
  hudName: '昔涟',
  hudDetail: 'full',
  hudAlpha: 0.9,
  hudScale: 1,
  hudFontScale: 1,
  channels: {
    qq: {
      enabled: false,
      transport: 'gateway',
      appId: '',
      credentialRef: 'vault:qq-token',
      ownerOpenIds: [],
      targetOpenId: '',
      publicKey: '',
      webhookPort: 8787
    }
  },
  // 默认樱粉：这是昔涟自己的色调，也是新安装第一眼看到的配色。
  theme: { preset: 'SakuraPink', custom: {} },
  modules: {
    // 三个内置模块的默认开关。宿主启动时按这里的 enabled 决定是否 bootstrap。
    // balance 默认关：它要外网 + API Key，首次启动就发请求会让「装完能不能跑」
    // 的验证被网络噪音干扰，也避免用户在不知情时产生外部请求。
    'builtin.bubble': { enabled: true, permissions: ['ui.render'] },
    'builtin.reminder': { enabled: true, permissions: ['memory.read', 'memory.write'] },
    'builtin.balance': { enabled: false, permissions: ['net.egress'] }
  },
  defaultEmotion: 'neutral',
  // 空串 = 还没导入模型。首次启动时桌宠会显示「导入本地模型」引导。
  live2dModelId: ''
}

/** v1 配置里可能出现的字段，仅用于迁移读取。 */
export interface SettingsV1 {
  readonly nickname?: string
  readonly ui?: UiMode
  readonly scale?: number
  readonly font?: number
  readonly bubbleRadius?: number
  readonly bubbleAlpha?: number
  readonly showHud?: boolean
  readonly hudName?: string
  readonly hudDetail?: 'full' | 'simple' | 'simple2'
  readonly hudAlpha?: number
  readonly channels?: ChannelsConfig
  readonly askEvery?: number
  readonly askHandling?: AskHandling
  readonly poseEvery?: number
  readonly soundLevel?: number
  readonly [key: string]: unknown
}
