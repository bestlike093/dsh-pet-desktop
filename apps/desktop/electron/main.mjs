import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  protocol,
  net,
  shell,
  Tray,
  Menu,
  nativeImage,
  screen,
  powerMonitor,
  safeStorage,
  session
} from 'electron'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  DecisionGateway,
  LocalLoopbackChannel,
  OwnerPolicy,
  PermissionBroker,
  RockPaperScissors,
  SessionModeGate,
  applyIncomingMessage,
  createLocalTtsProvider,
  parseOwnerAllowlist
} from '../../../packages/core/dist/index.js'
import { DEFAULT_SETTINGS } from '../../../packages/shared/dist/index.js'
import {
  AesGcmProvider,
  KeyRingVaultStore,
  MemoryVaultStorage,
  VaultClient,
  VaultServiceSecretStore,
  createVault,
  createVaultBackup,
  migrateLegacyLlmKey,
  openVaultBackup,
  restrictPermissions,
  scrubLegacyLlmKey,
  writeRestoredKeyRing
} from '../../../packages/vault/dist/index.js'
import { IPC_CHANNELS, assertChannel, createWindowOptions } from '../dist/index.js'
import { QqOfficialChannel } from '../dist/remote/qqOfficialChannel.js'
import { QqGatewayChannel } from '../dist/remote/qqGatewayChannel.js'
import { QqBotApiClient } from '../dist/remote/qqbot-api-client.js'
import { createChatService } from './chat.mjs'
import { createPresenceService } from './presence.mjs'
import { createSystemStats } from './system-stats.mjs'
import { createAssetLibrary } from './assets.mjs'
import { createBalanceMonitor } from './balance-monitor.mjs'
import { createLedgerStore } from './balance-ledger-store.mjs'
import { createGameDailyService } from './game-daily.mjs'
import { readSlices, systemTimeZone } from './balance-ledger.mjs'
import { createMemoryStore } from './memory.mjs'
import { createModelStore } from './models.mjs'
import { createPackStore } from './packs.mjs'
import { buildPersonaPrompt } from './persona.mjs'
import { buildDailyReview, localDateKey, renderSummary, writeDailyReview } from './daily-review.mjs'
import {
  buildReflection,
  renderReflectionMarkdown,
  sanitizeReflectionText,
  writeReflection
} from './reflection.mjs'
import { isLoopbackEndpoint, planSpeak, probeTtsEndpoint, toTtsEndpoint } from './voice-service.mjs'
import { createSettingsSync } from './sync.mjs'
import { SYNC_SECRET_FIELD, SYNC_SECRET_SERVICE } from './syncCrypto.mjs'
import {
  mergeLayer,
  sanitizeSettingsPatch,
  SETTINGS_TOP_KEYS
} from '../dist/main/settings-patch.js'
import { quietModeAt } from '../dist/main/quiet-mode.js'
import { clampBoundsToWorkArea, dockBoundsToBottomRight } from '../dist/main/window-bounds.js'
import { presenceIntervalMs } from '../dist/main/state.js'
import { describeError } from '../dist/main/error.js'
import { buildMemoryDigest } from '../dist/main/memory.js'
import { registerQueryChannels } from '../dist/main/ipc/queries.js'
import { registerVoiceChannels } from '../dist/main/ipc/voice.js'
import { registerMutationChannels, runBackup } from '../dist/main/ipc/mutations.js'
import { registerModelChannels } from '../dist/main/ipc/models.js'
import { registerMemoryChannels } from '../dist/main/ipc/memory.js'
import { registerVaultChannels } from '../dist/main/ipc/vault.js'
import { registerBackupChannels } from '../dist/main/ipc/backup.js'
import { registerSecretChannels } from '../dist/main/ipc/secrets.js'
import { registerChatChannels } from '../dist/main/ipc/chat.js'
import { registerSyncChannels } from '../dist/main/ipc/sync.js'
import { registerDiagnosticsChannels } from '../dist/main/ipc/diagnostics.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/**
 * 单实例锁。
 *
 * 桌宠常驻托盘，双开会同时抢 settings.json、memory.bin、状态栏采样和
 * webhook 端口；第二个实例只会让「设置莫名其妙回滚」。拿不到锁就直接退出，
 * 由 whenReady 里的单实例判断兜住后续装配。
 */
const singleInstanceLock = app.requestSingleInstanceLock()
if (!singleInstanceLock) app.quit()

// Windows 靠这个 ID 把通知、任务栏分组、托盘归到桌宠自己名下；不设会落到 electron.exe。
app.setAppUserModelId('com.dshpet.desktop')

/**
 * 开发期环境变量开关。
 *
 * PET_* / QQ_BOT_* 能改媒体根、同步目录和 QQ 凭据来源，等于一条绕过设置页的
 * 接管路径。打包版一律不认，只有未打包且显式 PET_DEV_MODE=1 时才生效。
 */
const devEnvEnabled = !app.isPackaged && process.env.PET_DEV_MODE === '1'
function devEnv(name, fallback = '') {
  if (!devEnvEnabled) return fallback
  const value = process.env[name]
  return typeof value === 'string' && value !== '' ? value : fallback
}

const userData = app.getPath('userData')
const settingsPath = path.join(userData, 'settings.json')

/**
 * 同步目录与最近一次导出 / 合并时间。
 * 和 backup-prefs 同构：路径偏好不进 settings.json，也就不进同步包本身。
 */
const syncPrefsFile = path.join(userData, 'sync-prefs.json')
let syncPrefsCache = null
const statePath = path.join(userData, 'state.json')
const taskLogPath = path.join(userData, 'tasks.log')
const vaultKeysPath = path.join(userData, 'vault-keys.json')
const vaultStatePath = path.join(userData, 'vault-state.json')
const secretsPath = path.join(userData, 'secrets.bin')
const balanceLedgerPath = path.join(userData, 'balance-ledger.json')
/** 每日巡视与反思都只写这两个目录，路径不接受渲染侧传入。 */
const reportsDir = path.join(userData, 'reports')
const reflectionDir = path.join(userData, 'notes', 'reflection')
/** 当天记忆起点，用来算「今天新增了几条」；跨天自动换基线。 */
const dailyStatePath = path.join(userData, 'daily-state.json')
/** 聊过的内容加密后存这里；没有加密仓库就不写，明文不落盘。 */
const memoryPath = path.join(userData, 'memory.bin')
/** 聊天窗口的历史单独一份：记忆是给模型的摘要，历史是给用户回看的记录。 */
const chatHistoryPath = path.join(userData, 'chat.bin')
/** 猜拳战绩只存四个计数，坏了整体丢弃，不影响启动。 */
const rpsStatePath = path.join(userData, 'rps-state.json')

// 余额只查一个端点，硬编码在这里，不开放给渲染侧传 URL。
const BALANCE_ENDPOINT = 'https://api.deepseek.com/user/balance'
const BALANCE_SERVICE = 'deepseek'
const BALANCE_FIELD = 'api_key'

/**
 * 媒体根目录：Live2D 模型所在的父目录。
 *
 * 模型由使用者自己从作者处下载后导入，统一放在 userData/models，
 * 这样卸载重装、换版本都不会丢，也不受安装目录写权限限制。
 * PET_MEDIA_ROOT 只用于开发期临时指到别处。
 *
 * 渲染进程永远拿不到真实绝对路径，只能经 pet-media://model/<相对路径> 访问，
 * 这样即使模型目录里有别的东西，页面也读不到。
 */
const mediaRoot = devEnv('PET_MEDIA_ROOT') || path.join(userData, 'models')

/**
 * 随包素材根：开发时是仓库根 assets/，打包后是 app 根 assets/。
 * electron-builder.yml 里 assets/** 已按这个位置写死，两边必须一致。
 */
const assetsRoot = path.join(app.getAppPath(), 'assets')

/**
 * 应用图标：Cyrene 自绘素材（来源见 assets/ATTRIBUTION.md）。
 * 窗口与任务栏都用它，读不到时交给 Electron 回落到可执行文件图标。
 */
const appIconPath = path.join(assetsRoot, 'cyrene', 'icons', 'app-cyrene.png')

/** 随包素材清单：扫目录、拼 pet-media://asset 地址，逻辑放在 assets.mjs。 */
const assetLibrary = createAssetLibrary({ root: assetsRoot })

/** Live2D 模型库：扫描 / 导入 / 校验都在这里，主进程只做接线。 */
const modelStore = createModelStore({ root: mediaRoot, log })

/**
 * 用户导入的静态素材（字体 / 图标 / 气泡 / 表情），与 models 目录严格分开。
 * PET_PACKS_ROOT 只用于开发期临时指到别处。
 */
const packsRoot = devEnv('PET_PACKS_ROOT') || path.join(userData, 'packs')
/** 内置素材包跟 assets 走：开发时在仓库根，打包后在 asar 内的 app 根。 */
const builtinPacksRoot = devEnv('PET_BUILTIN_PACKS_ROOT') || path.join(assetsRoot, 'packs')
const packStore = createPackStore({ root: packsRoot, builtinRoot: builtinPacksRoot, log })

/** 本机设置同步：只写 userData/sync（或 PET_SYNC_DIR），不连远端端点。 */
let settingsSync = null

// 必须在 app ready 之前声明权限，否则 fetch / img 会把 pet-media 判成不透明来源。
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'pet-media',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true
    }
  }
])

let settings = DEFAULT_SETTINGS
let win = null

/** 第二个实例被拦住后，把已经存在的桌宠窗口叫到前面。 */
app.on('second-instance', () => {
  if (win === null || win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
})

let tray = null
let gateway = null
let qq = null
let webhookServer = null
/**
 * QQ 运行状态：设置页只读，不参与决策。
 * state: off（未启用）/ starting（正在连）/ ready（可用）/ error（配置或连接失败）
 */
const qqRuntime = {
  enabled: false,
  transport: 'gateway',
  state: 'off',
  reason: '',
  webhookListening: false,
  webhookPort: 0,
  webhookError: ''
}
function setQqRuntime(patch) {
  Object.assign(qqRuntime, patch)
}
let sessionIdleTimer = null
/** 装配失败时保持 null；IPC 会明确报错，不静默降级。 */
let vault = null
/** 启动时密钥环重建/隔离的提示；只在主界面加载完成后送一次。 */
let vaultStartupNotice = null
let vaultNoticeDelivered = false
/** seal / open 的唯一出口；vault 失败时保持 null，记忆宁可不写也不退回明文。 */
let vaultClient = null
let secretStore = null
/**
 * 旧密钥迁移失败的原因；非 null 表示 settings.json 里可能还留着明文 Key。
 * 一旦置上就不能自己消失：只有下一次迁移成功才清空，避免「重启一次看着就没事了」。
 */
let legacyKeyMigrationWarning = null
/** 独立设置窗；单例，关闭后置回 null。 */
let settingsWin = null
/** 能力中心；单例。 */
let abilityWin = null
/** 猜拳战绩只留内存：小游戏没有跨会话留存的价值，重启即清。 */
/** 猜拳战绩：内存一份，落盘一份；非自洽数据整体忽略。 */
const rpsGame = new RockPaperScissors()

async function loadRpsStats() {
  try {
    const raw = await fs.readFile(rpsStatePath, 'utf8')
    const parsed = JSON.parse(raw)
    if (!rpsGame.restore(parsed)) log('[rps] 战绩不自洽，已忽略：', rpsStatePath)
  } catch (error) {
    // 首次启动没有文件是正常情况，不吵。
    if (error?.code !== 'ENOENT') log('[rps] 战绩读取失败：', error?.message ?? error)
  }
}

async function saveRpsStats() {
  try {
    await fs.writeFile(rpsStatePath, JSON.stringify(rpsGame.stats), 'utf8')
  } catch (error) {
    // 写不进去不影响出拳，只记一条。
    log('[rps] 战绩写入失败：', error?.message ?? error)
  }
}
/** 首次引导窗；也是单例，走完或关掉后置回 null。 */
let onboardingWin = null
/** 主窗口渲染侧的实时状态，由 renderer 定时上报，供设置窗展示诊断。 */
let lastRenderInfo = null
/** 聊天窗；单例，关闭后置回 null。 */
let chatWin = null

// mergeLayer / sanitizeSettingsPatch / SETTINGS_TOP_KEYS 已迁到 src/main/settings-patch.ts。

/** 记忆：加密落盘 + 提示词片段。未启用时只在内存里留历史。 */
const memoryStore = createMemoryStore({
  filePath: memoryPath,
  getMaxItems: () => settings?.companion?.memory?.maxItems,
  seal: async (value) => {
    if (vaultClient === null) throw new Error('vault 未就绪，拒绝以明文写记忆')
    return await vaultClient.seal(value, { kind: 'envelope' })
  },
  open: async (sealed) => {
    if (vaultClient === null) throw new Error('vault 未就绪，无法读取记忆')
    // 轮换密钥后旧记忆的 keyEpoch 会落后，但仍要能读：keyId 还在 ring 里。
    return await vaultClient.open(sealed, { allowLegacyEpoch: true })
  },
  log
})

function memoryEnabled() {
  return settings?.companion?.memory?.enabled === true
}

/**
 * 聊天历史：和记忆同一套加密封装，但单独文件、独立上限。
 * 记忆是给模型的摘要，历史是给用户回看的原文；两者不能混用一份。
 */
const chatHistoryStore = createMemoryStore({
  filePath: chatHistoryPath,
  maxItems: 200,
  seal: async (value) => {
    if (vaultClient === null) throw new Error('vault 未就绪，拒绝以明文写聊天历史')
    return await vaultClient.seal(value, { kind: 'envelope' })
  },
  open: async (sealed) => {
    if (vaultClient === null) throw new Error('vault 未就绪，无法读取聊天历史')
    // 同记忆：轮换后旧会话仍按原 keyId 解开，不因为 epoch 前进读不出来。
    return await vaultClient.open(sealed, { allowLegacyEpoch: true })
  },
  log
})

// buildMemoryDigest 已迁到 src/main/memory.ts，调用点注入存储与历史。

/** 聊天服务：密钥现取现用，短期历史在内存，长期记忆加密落盘。 */
const chatService = createChatService({
  getSettings: () => settings,
  getApiKey: async () => {
    const store = requireSecretStore()
    return await store.get(BALANCE_SERVICE, BALANCE_FIELD)
  },
  getPersonaText: (current) => buildPersonaPrompt(current).text,
  getMemoryDigest: () =>
    buildMemoryDigest({
      enabled: memoryEnabled(),
      ...memoryStore.stats(),
      items: memoryStore.recent(40),
      historyLength: chatService.history().length
    }),
  onExchange: ({ user, assistant, at }) => {
    if (!memoryEnabled()) return
    memoryStore.appendTurn('user', user, at)
    memoryStore.appendTurn('assistant', assistant, at)
  },
  // 聊天历史独立落盘；加密仓库不可用时 appendTurn 返回 false，自动退回内存。
  persistTurn: (turn) => {
    chatHistoryStore.appendTurn(turn.role, turn.content, turn.at)
  },
  persistClear: () => chatHistoryStore.clear(),
  fetchImpl: (url, init) => net.fetch(url, init),
  log
})

/**
 * 主进程日志：控制台 + userData/logs/main.log。
 *
 * 打包后用户看不到控制台，崩溃、通道失败、素材 404 就只能靠猜。
 * 单文件 5 MB 轮转一次（main.log → main.log.1），写日志失败一律静默，
 * 绝不能因为日志写不进去把主流程带崩。
 */
const logDir = path.join(userData, 'logs')
const logFilePath = path.join(logDir, 'main.log')
const LOG_MAX_BYTES = 5 * 1024 * 1024
let logReady = false
let logBytes = 0

function appendLogFile(line) {
  try {
    if (!logReady) {
      fsSync.mkdirSync(logDir, { recursive: true })
      logReady = true
      try {
        logBytes = fsSync.statSync(logFilePath).size
      } catch {
        logBytes = 0
      }
    }
    if (logBytes > LOG_MAX_BYTES) {
      try {
        fsSync.renameSync(logFilePath, `${logFilePath}.1`)
      } catch {
        fsSync.writeFileSync(logFilePath, '')
      }
      logBytes = 0
    }
    fsSync.appendFileSync(logFilePath, line)
    logBytes += Buffer.byteLength(line)
  } catch {
    // 磁盘满 / 目录只读：退回只有控制台
  }
}

function formatLogArg(value) {
  if (typeof value === 'string') return value
  if (value instanceof Error) return value.stack ?? value.message
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function log(...args) {
  console.log('[desktop]', ...args)
  appendLogFile(`${new Date().toISOString()} [desktop] ${args.map(formatLogArg).join(' ')}\n`)
}

/** 主进程主动说一句。窗口不在或已销毁就安静跳过，不排队补发。 */
function sendBubble(text, motion = null, meta = null) {
  if (typeof text !== 'string' || text.trim() === '') return false
  if (win === null || win.isDestroyed()) return false
  win.webContents.send('pet:bubble', {
    text,
    // AI 挑的动作名；渲染层按素材真实能力决定播不播，null 表示这句不带动作。
    motion: typeof motion === 'string' && motion !== '' ? motion : null,
    // 可选 ack 键：只有带它的气泡才显示「知道了」，点击后升 confirmed。
    ackSegment:
      typeof meta?.ackSegment === 'string' && meta.ackSegment !== '' ? meta.ackSegment : null
  })
  return true
}

/**
 * 主动说话的情境层。
 *
 * 和聊天服务分开：主动台词不该写进聊天历史，也不该被「正在聊天」挡住。
 * 密钥、人格、记忆全部复用主进程现成的那一份。
 */
const presenceService = createPresenceService({
  getSettings: () => settings,
  getApiKey: async () => {
    const store = requireSecretStore()
    return await store.get(BALANCE_SERVICE, BALANCE_FIELD)
  },
  getMemoryDigest: () =>
    buildMemoryDigest({
      enabled: memoryEnabled(),
      ...memoryStore.stats(),
      items: memoryStore.recent(40),
      historyLength: chatService.history().length
    }),
  getPersonaText: (current) => buildPersonaPrompt(current).text,
  // 动作清单来自渲染层每 2 秒的上报；还没上报过就是 null，提示词里不会凭空出现动作。
  getMotionCatalog: () => lastRenderInfo?.motion ?? null,
  fetchImpl: (url, init) => net.fetch(url, init),
  log
})

/**
 * 桌面状态条的系统指标。
 *
 * 采样器只往主窗口推；窗口不在就丢弃这一拍，不排队。桌面状态条默认关闭，
 * 但采样很轻（3 秒一次 os 差值 + 6 秒一次 PowerShell），常驻不影响启动。
 */
const systemStats = createSystemStats({
  app,
  log,
  onStats: (stats) => {
    if (win === null || win.isDestroyed()) return
    win.webContents.send('pet:system:stats', stats)
  }
})

let presenceTimer = null

// presenceIntervalMs 已迁到 src/main/state.ts，调用点传原始分钟值。

// quietModeAt 已迁到 src/main/quiet-mode.ts，调用点显式传 settings.presence.quiet。

/**
 * 主动说话定时器：每 30 秒对一次表，到点才请求模型。
 * 不把间隔直接写进 setInterval —— 设置改完要立刻生效，不用等这一轮走完。
 */
let lastSpokenAt = 0
/** 锁屏或休眠期间不搭话；唤醒后把计时起点推到现在，不补发。 */
let systemAsleep = false

function startPresenceTimer() {
  if (presenceTimer !== null) return
  presenceTimer = setInterval(() => {
    if (settings?.presence?.aiEnabled !== true) return
    if (win === null || win.isDestroyed() || !win.isVisible()) return
    if (systemAsleep) return
    // 临时安静（专注模式）：到点自动恢复，不需要改设置。
    if (isTemporarilyQuiet()) return
    // 夜间不扰：静音与「只留提醒」都跳过搭话；降频把间隔拉长到 3 倍。
    const quietMode = quietModeAt(new Date(), settings?.presence?.quiet)
    if (quietMode === 'silent' || quietMode === 'urgentOnly') return
    const interval = presenceIntervalMs(settings?.presence?.intervalMinutes) * (quietMode === 'reduce' ? 3 : 1)
    if (Date.now() - lastSpokenAt < interval) return
    lastSpokenAt = Date.now()
    void presenceService.nextLine('auto').then((result) => {
      if (typeof result.line === 'string' && result.line !== '') sendBubble(result.line, result.motion)
    })
  }, 30_000)
  presenceTimer.unref?.()
}

/** 由 registerIpc 注入的日报执行入口；定时器通过它触发，不复制第二套逻辑。 */
let dailyReviewRunner = null
let dailyReviewTimer = null
let lastDailyReviewDate = null

/**
 * 每日巡视定时器：每 30 秒对一次表。
 * 关掉开关只是不触发；同一天最多跑一次，避免休眠唤醒后连续补跑。
 */
function startDailyReviewTimer() {
  if (dailyReviewTimer !== null) return
  dailyReviewTimer = setInterval(() => {
    const care = settings?.companion?.care?.dailyReview
    if (care?.enabled !== true) return
    if (dailyReviewRunner === null) return
    // 临时安静期间连提醒也一起停，结束后不补发。
    if (isTemporarilyQuiet()) return

    const now = new Date()
    const today = localDateKey(now)
    if (lastDailyReviewDate === today) return

    const at = typeof care.at === 'string' ? care.at : '22:30'
    const [hour, minute] = at.split(':').map((part) => Number(part))
    if (!Number.isInteger(hour) || !Number.isInteger(minute)) return
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return
    // 用「到点没到点」判断，不用「正好这一分钟」：
    // 休眠、关盖子、系统卡顿都会让 30 秒轮询错过整分钟，旧写法当天就不发了。
    const dueMinutes = hour * 60 + minute
    const nowMinutes = now.getHours() * 60 + now.getMinutes()
    if (nowMinutes < dueMinutes) return

    // 夜间不扰选「完全静音」时，日报也不发；降频与「保留提醒」都照常。
    if (quietModeAt(now, settings?.presence?.quiet) === 'silent') return

    lastDailyReviewDate = today
    void dailyReviewRunner().then((result) => {
      if (result.ok) sendBubble(result.summary)
    })
  }, 30_000)
  dailyReviewTimer.unref?.()
}

let tempFileSeq = 0

/** 读 JSON 时统一去 BOM：手工编辑 / PowerShell / 备份工具常写出带 BOM 的 UTF-8。 */
async function readJsonFile(file) {
  const raw = await fs.readFile(file, 'utf8')
  return JSON.parse(raw.replace(/^\uFEFF/, ''))
}

async function readJson(file, fallback) {
  try {
    return await readJsonFile(file)
  } catch {
    return fallback
  }
}

/**
 * 设置文件单独处理：主文件坏了先用 .bak，绝不再静默回默认。
 * 两份都不可用时把主文件改名隔离，留证据，也避免下一次写入覆盖唯一的坏文件。
 */
async function readSettings() {
  const candidates = [settingsPath, `${settingsPath}.bak`]
  for (let index = 0; index < candidates.length; index += 1) {
    const file = candidates[index]
    try {
      const value = await readJsonFile(file)
      // JSON 合法不等于结构正确：历史版本曾把文件写成一行路径字符串，
      // 解析能过但没有 window，启动时会在 createWindowOptions 崩掉。
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('settings 根节点不是对象')
      }
      if (index > 0) {
        log('[settings] 主设置不可用，已从备份读取')
        await writeSettings(value).catch((error) =>
          log('[settings] 备份回写失败：', error?.message ?? error)
        )
      }
      return value
    } catch (error) {
      if (error?.code === 'ENOENT') continue
      log('[settings] 读取失败：', file, error?.message ?? error)
    }
  }

  try {
    const quarantine = `${settingsPath}.corrupt-${Date.now()}`
    await fs.rename(settingsPath, quarantine)
    log('[settings] 设置文件与备份均不可用，已隔离：', quarantine)
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      log('[settings] 隔离损坏设置失败：', error?.message ?? error)
    }
  }
  return {}
}

/** 每次写设置前备份上一份可解析的内容；坏文件不配覆盖好备份。 */
async function writeSettings(value) {
  // 再兜一道：调用方把路径、字符串或数组递进来时当场拒绝。
  // 不拦的话 settings.json 会被写成一行路径，下次启动 createWindowOptions 直接崩。
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`settings 必须是对象，已拒绝写入 ${typeof value}`)
  }
  try {
    const previous = await readJsonFile(settingsPath)
    await writeJsonAtomic(`${settingsPath}.bak`, previous)
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      log('[settings] 旧设置无法解析，保留现有备份：', error?.message ?? error)
    }
  }
  await writeJsonAtomic(settingsPath, value)
}

async function writeJson(file, value) {
  await writeJsonAtomic(file, value)
}

/** 账本读取要区分「文件不存在」与「读坏了」：前者是新装，后者必须让迁移失败可见。 */
async function readJsonStrict(file, fallback) {
  try {
    return await readJsonFile(file)
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback
    throw error
  }
}

/** 临时文件替换，断电不会留下半截 JSON；序号避免并发写互相覆盖。 */
async function writeJsonAtomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  tempFileSeq += 1
  const temp = `${file}.${process.pid}.${tempFileSeq}.tmp`
  try {
    await fs.writeFile(temp, JSON.stringify(value, null, 2), 'utf8')
    await fs.rename(temp, file)
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => {})
    throw error
  }
}

// localDateKey 统一从 daily-review.mjs 引入：两套实现会让账本和日报各算各的日期。

/** 余额账本单例；迁移与裁剪由 store 负责，宿主只提供读写路径。 */
let balanceLedgerStore = null
/** 轮询器；设置变更时 updateInterval，退出时 stop。 */
let balanceMonitor = null

function ensureBalanceStore() {
  if (balanceLedgerStore === null) {
    balanceLedgerStore = createLedgerStore({
      read: () => readJsonStrict(balanceLedgerPath, null),
      write: (value) => writeJsonAtomic(balanceLedgerPath, value),
      timeZone: () => systemTimeZone()
    })
  }
  return balanceLedgerStore
}

/**
 * 抓一次余额，失败抛带 code 的 Error。
 *
 * monitor 的 `fetchBalance` 靠 reject 拿原因；这里不把 HTTP 状态伪装成成功。
 * Key 只在这里读一次，用完即弃，不回传、不写日志。
 */
async function fetchBalanceSnapshot() {
  let apiKey = null
  try {
    apiKey = await requireSecretStore().get(BALANCE_SERVICE, BALANCE_FIELD)
  } catch (error) {
    const failure = new Error('vault unavailable')
    failure.code = 'vault-unavailable'
    failure.cause = error
    throw failure
  }
  if (apiKey === null) {
    const failure = new Error('no key')
    failure.code = 'no-key'
    throw failure
  }

  let payload = null
  try {
    const response = await net.fetch(BALANCE_ENDPOINT, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' }
    })
    if (!response.ok) {
      const failure = new Error(`HTTP ${response.status}`)
      failure.code = 'request-failed'
      throw failure
    }
    payload = await response.json()
  } catch (error) {
    if (error?.code === 'request-failed') throw error
    const failure = new Error(String(error?.message ?? error))
    failure.code = 'request-failed'
    failure.cause = error
    throw failure
  }

  const infos = Array.isArray(payload?.balance_infos) ? payload.balance_infos : []
  const cny = infos.find((item) => item?.currency === 'CNY') ?? infos[0] ?? null
  const asNumber = (value) => {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  const balance = asNumber(cny?.total_balance)
  if (balance === null) {
    const failure = new Error('balance missing')
    failure.code = 'balance-missing'
    throw failure
  }

  return {
    balance,
    threshold: settings.balance.threshold,
    fetchedAt: Date.now(),
    isAvailable: payload?.is_available === true,
    currency: typeof cny?.currency === 'string' ? cny.currency : 'CNY',
    grantedBalance: asNumber(cny?.granted_balance),
    toppedUpBalance: asNumber(cny?.topped_up_balance)
  }
}

/** 按当前设置启动 / 调整 / 停掉轮询；在 settings 广播后调用，所以改配置不重启。 */
function syncBalanceMonitor() {
  const enabled = settings?.modules?.['builtin.balance']?.enabled === true
  if (!enabled) {
    balanceMonitor?.stop()
    return
  }

  const minutes = Number(settings?.balance?.intervalMinutes)
  const intervalMs = Math.max(1, Math.min(1440, Number.isFinite(minutes) ? minutes : 30)) * 60_000

  if (balanceMonitor === null) {
    balanceMonitor = createBalanceMonitor({
      store: ensureBalanceStore(),
      fetchBalance: fetchBalanceSnapshot,
      intervalMs,
      onAlert: (alert) =>
        sendBubble(
          `余额只剩 ${alert.balance.toFixed(2)} 元，低于 ${alert.threshold} 元啦。`,
          null,
          { ackSegment: alert.segment }
        ),
      onError: (error) => log('[balance]', error?.code ?? error)
    })
    balanceMonitor.start()
    return
  }

  balanceMonitor.updateInterval(intervalMs)
  if (!balanceMonitor.isRunning()) balanceMonitor.start()
}

function stopBalanceMonitor() {
  balanceMonitor?.stop()
  balanceMonitor = null
}

/** 游戏日常单例：只读写排班与检测，不启动真实执行器。 */
let gameDailyService = null

function ensureGameDailyService() {
  if (gameDailyService === null) {
    gameDailyService = createGameDailyService({
      filePath: path.join(userData, 'game-daily.json'),
      writeConfig: (target, config) => writeJsonAtomic(target, config)
    })
  }
  return gameDailyService
}

function sendDecision(outcome) {
  if (win === null || win.isDestroyed()) return
  win.webContents.send('pet:decision', outcome)
}

let gatewayFingerprint = ''
let gatewaySyncTimer = null
/** 设置页写入 AppSecret 时使用的 Vault 服务名，与 renderer 保持一致。 */
const QQ_SECRET_SERVICE = 'qq-token'

/** 凭据引用：`vault:<service>` 或 `vault:<service>:<field>`。 */
function readQqCredentialRef(ref) {
  const match = /^vault:([A-Za-z][A-Za-z0-9_-]{0,63})(?::([A-Za-z][A-Za-z0-9_-]{0,63}))?$/.exec(
    typeof ref === 'string' ? ref.trim() : ''
  )
  if (match === null) return null
  return { service: match[1], field: match[2] ?? 'value' }
}

async function readQqClientSecret(ref) {
  if (secretStore === null) return ''
  const parsed = readQqCredentialRef(ref)
  if (parsed === null) return ''
  try {
    return (await secretStore.get(parsed.service, parsed.field)) ?? ''
  } catch (error) {
    log('[qq] 读取 Vault 凭据失败：', error instanceof Error ? error.message : String(error))
    return ''
  }
}

/** QQ 配置指纹：只有真正相关的字段变化才重建连接。 */
function qqFingerprint() {
  return JSON.stringify({
    channels: settings.channels?.qq ?? null,
    appId: devEnv('QQ_BOT_APP_ID'),
    owner: devEnv('QQ_BOT_OWNER_OPENID'),
    target: devEnv('QQ_BOT_OPENID'),
    publicKey: devEnv('QQ_BOT_PUBLIC_KEY'),
    port: devEnv('QQ_WEBHOOK_PORT')
  })
}

/**
 * 设备标识：首次启动生成一次，落在 userData/device-id.json。
 *
 * 原来固定写 'desktop-local'，同一台机器多份数据目录、或两台机器同时上报时
 * 会在远端合并成同一个节点，统计与去重都失真。开发期仍可用 PET_DEVICE_ID 覆盖。
 */
let deviceIdCache = null
async function resolveDeviceId() {
  if (deviceIdCache !== null) return deviceIdCache

  const override = devEnv('PET_DEVICE_ID')
  if (override !== '') {
    deviceIdCache = override
    return deviceIdCache
  }

  const file = path.join(userData, 'device-id.json')
  try {
    const saved = await readJsonFile(file)
    if (typeof saved?.deviceId === 'string' && saved.deviceId.length >= 8) {
      deviceIdCache = saved.deviceId
      return deviceIdCache
    }
  } catch {
    // 不存在或损坏都重新生成；下面会覆盖写回
  }

  deviceIdCache = randomUUID()
  await writeJsonAtomic(file, { deviceId: deviceIdCache }).catch((error) =>
    log('[device-id] 写入失败，本次运行使用临时 ID：', error?.message ?? error)
  )
  return deviceIdCache
}

async function createGateway() {
  const local = new LocalLoopbackChannel()

  const qqSettings = settings.channels?.qq ?? DEFAULT_SETTINGS.channels.qq
  const envAppId = devEnv('QQ_BOT_APP_ID')
  const envSecret = devEnv('QQ_BOT_SECRET')
  const appId = envAppId.length > 0 ? envAppId : qqSettings.appId
  const envOwners = parseOwnerAllowlist(devEnv('QQ_BOT_OWNER_OPENID'))
  const ownerOpenIds =
    envOwners.length > 0 ? envOwners : [...(qqSettings.ownerOpenIds ?? [])]
  const targetOpenId = devEnv('QQ_BOT_OPENID') || qqSettings.targetOpenId || ''
  const publicKey = devEnv('QQ_BOT_PUBLIC_KEY') || qqSettings.publicKey || ''
  const transport = qqSettings.transport === 'webhook' ? 'webhook' : 'gateway'
  // 环境变量配置齐全时视为显式启用，保持旧版本行为；否则看设置开关。
  const enabled =
    (envAppId.length > 0 && envSecret.length > 0) || qqSettings.enabled === true
  setQqRuntime({
    enabled,
    transport,
    state: enabled ? 'starting' : 'off',
    reason: enabled ? '' : 'QQ 通道未启用',
    webhookListening: false,
    webhookPort: 0,
    webhookError: ''
  })

  const ownerPolicy = new OwnerPolicy(ownerOpenIds)
  const permissionBroker = new PermissionBroker()
  const sessionGate = new SessionModeGate({ broker: permissionBroker })
  sessionGate.onChange((entry) => {
    log(`[session] ${entry.from ?? '-'} → ${entry.to}（${entry.reason}）`)
  })
  // 提权后长时间没动静要自己收回；不在 SessionModeGate 内部起定时器，由宿主驱动。
  if (sessionIdleTimer !== null) clearInterval(sessionIdleTimer)
  sessionIdleTimer = setInterval(() => {
    if (sessionGate.tick()) log('[session] 空闲降回 chat')
  }, 60_000)
  sessionIdleTimer.unref?.()

  qq = null
  if (enabled) {
    const clientSecret = envSecret.length > 0 ? envSecret : await readQqClientSecret(qqSettings.credentialRef)
    if (appId.length === 0) {
      setQqRuntime({ state: 'error', reason: '缺少 AppID' })
      log('[qq] 未启用：缺少 AppID')
    } else if (clientSecret.length === 0) {
      setQqRuntime({ state: 'error', reason: '缺少 AppSecret（Vault 里没有对应条目）' })
      log('[qq] 未启用：缺少 AppSecret（Vault 里没有对应条目）')
    } else if (ownerOpenIds.length === 0) {
      // 没有主人名单时，任何消息都无法确认来源，通道保持不启用。
      setQqRuntime({ state: 'error', reason: '缺少主人 openid，无法判断谁可以拍板' })
      log('[qq] 未启用：缺少主人 openid，无法判断谁可以拍板')
    } else if (transport === 'gateway') {
      const channel = new QqGatewayChannel({
        appId,
        clientSecret,
        ownerOpenIds,
        ...(targetOpenId.length === 0 ? {} : { targetOpenId }),
        onLog: (message) => log(message),
        onError: (error) => {
          setQqRuntime({ state: 'error', reason: `网关错误：${error.message}` })
        }
      })
      channel.onReadyChange?.((ready) => {
        setQqRuntime({
          state: ready ? 'ready' : 'error',
          reason: ready ? '' : '网关连接已断开，正在重连'
        })
      })
      try {
        await channel.start()
        qq = channel
        // start() 只负责建连，不等握手；错误回调可能已经先写入 error，不能覆盖。
        if (channel.isReady === true) {
          setQqRuntime({ state: 'ready', reason: '' })
        } else if (qqRuntime.state !== 'error') {
          setQqRuntime({ state: 'starting', reason: '正在连接 QQ 网关' })
        }
        log('[qq] 网关通道已启动')
      } catch (error) {
        await channel.stop().catch(() => undefined)
        const message = error instanceof Error ? error.message : String(error)
        setQqRuntime({ state: 'error', reason: `网关启动失败：${message}` })
        log('[qq] 网关启动失败：', message)
      }
    } else if (publicKey.length === 0) {
      // 没有公钥就无法验签，webhook 等于对任何能连上端口的人敞开。
      setQqRuntime({ state: 'error', reason: '缺少 QQ 公钥，webhook 无法验签' })
      log('[qq] 未启用：缺少 QQ 公钥，webhook 无法验签')
    } else {
      qq = new QqOfficialChannel({
        appId,
        clientSecret,
        publicKey,
        ownerOpenIds,
        ...(targetOpenId.length === 0 ? {} : { target: { kind: 'c2c', openId: targetOpenId } })
      })
    }
  }

  gateway = new DecisionGateway({
    deviceId: await resolveDeviceId(),
    channels: qq === null ? [local] : [local, qq],
    timeoutMs: 300_000,
    timeoutPolicy: 'fallback-local',
    // 远程回复必须带 spoof-resistant 身份，并且只在主人私聊里才放行。
    authorizeReply: (reply, _envelope, channelId) => {
      const sender = reply.sender
      if (sender === undefined) return false
      if (sender.chatType === undefined) {
        log(`[decision] 拒绝无会话类型的回复：channel=${channelId}`)
        return false
      }
      const message = { userId: sender.id, chatType: sender.chatType }
      if (!ownerPolicy.isOwner(message)) {
        log(`[decision] 拒绝非主人回复：channel=${channelId} chat=${sender.chatType}`)
        return false
      }
      applyIncomingMessage(sessionGate, ownerPolicy, message)
      return true
    }
  })

  if (qq !== null && transport === 'webhook') {
    const envPort = devEnv('QQ_WEBHOOK_PORT')
    const rawPort = Number(
      envPort !== '' ? envPort : (qqSettings.webhookPort ?? DEFAULT_SETTINGS.channels.qq.webhookPort)
    )
    const port = Number.isInteger(rawPort) && rawPort >= 1 && rawPort <= 65535 ? rawPort : 8787
    const server = http.createServer(async (request, response) => {
      if (request.method !== 'POST' || request.url !== '/qq/webhook') {
        response.writeHead(404).end()
        return
      }
      let body = ''
      for await (const chunk of request) {
        body += chunk
        if (body.length > 64 * 1024) {
          response.writeHead(413).end()
          return
        }
      }
      try {
        const result = await qq.handleWebhook(body, request.headers)
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify(result))
      } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error ? error.code : 'UNKNOWN'
        const status = code === 'SIGNATURE_INVALID'
          ? 401
          : code === 'CHANNEL_NOT_CONFIGURED'
            ? 503
            : 400
        response.writeHead(status, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: String(code) }))
      }
    })
    webhookServer = server
    setQqRuntime({ webhookPort: port })
    server.on('error', (error) => {
      const message = error instanceof Error ? error.message : String(error)
      setQqRuntime({
        state: 'error',
        reason: `webhook 监听失败：${message}`,
        webhookListening: false,
        webhookError: message
      })
      log('[qq] webhook 监听失败：', message)
      try {
        server.close()
      } catch {
        // 监听失败时 close 可能同步抛错，端口没有真正占上。
      }
      if (webhookServer === server) webhookServer = null
    })
    server.listen(port, '127.0.0.1', () => {
      setQqRuntime({
        state: 'ready',
        reason: '',
        webhookListening: true,
        webhookError: ''
      })
      log(`QQ webhook 监听 127.0.0.1:${port}/qq/webhook`)
    })
  }

  gatewayFingerprint = qqFingerprint()
}

/** 设置变更后按指纹重建；配置没变时不动现有连接。 */
function scheduleGatewaySync() {
  if (gatewaySyncTimer !== null) clearTimeout(gatewaySyncTimer)
  gatewaySyncTimer = setTimeout(() => {
    gatewaySyncTimer = null
    void syncGatewayIfNeeded().catch((error) =>
      log('[qq] 重建通道失败：', error instanceof Error ? error.message : String(error))
    )
  }, 400)
  gatewaySyncTimer.unref?.()
}

async function syncGatewayIfNeeded(force = false) {
  // 凭据写入磁盘不会改变 settings 指纹，必须由调用方显式强制重建。
  if (!force && gateway !== null && qqFingerprint() === gatewayFingerprint) return
  gateway?.dispose()
  gateway = null
  if (webhookServer !== null) {
    webhookServer.close()
    webhookServer = null
  }
  const previous = qq
  qq = null
  if (previous !== null) await previous.stop?.().catch(() => undefined)
  await createGateway()
}

/**
 * 旧版把 LLM Key 明文写在 settings.json。启动时迁进 Vault 的 service store，
 * 擦掉明文再写回。迁移失败不影响启动，只记原因，不记 Key 本身。
 */

/** 备份与导入只碰这三个本机数据文件；模型和素材不进备份。 */
const BACKUP_FILES = ['secrets.bin', 'memory.bin', 'vault-state.json']

/** 旧数据文件是否还在：用来区分「首次安装」和「密钥丢了但旧数据还在」。 */
async function hasVaultDataFiles() {
  for (const name of BACKUP_FILES) {
    try {
      await fs.access(path.join(userData, name))
      return true
    } catch {
      // 继续看下一个文件。
    }
  }
  return false
}

async function readBackupFiles() {
  const files = []
  for (const name of BACKUP_FILES) {
    try {
      files.push({ name, data: new Uint8Array(await fs.readFile(path.join(userData, name))) })
    } catch {
      // 没写过的文件不放进备份，导入时也不会凭空造一个空文件。
    }
  }
  return files
}

// describeError 已迁到 src/main/error.ts。

async function migrateLegacySettingsKey(store) {
  const raw = await readSettings()
  const legacy = typeof raw === 'object' && raw !== null ? raw : {}
  const adapter = {
    getApiKey: () => store.get(BALANCE_SERVICE, BALANCE_FIELD),
    setApiKey: (key) => store.set(BALANCE_SERVICE, key, BALANCE_FIELD),
    clearApiKey: () => store.clear(BALANCE_SERVICE, BALANCE_FIELD)
  }

  try {
    const result = await migrateLegacyLlmKey(legacy, adapter)
    legacyKeyMigrationWarning = null
    if (!result.migrated) return
    const scrubbed = scrubLegacyLlmKey(legacy)
    await writeSettings(scrubbed)
    settings = mergeLayer(DEFAULT_SETTINGS, scrubbed)
    log('[secrets] 旧版明文 LLM Key 已迁入 Vault，并从 settings.json 擦除')
  } catch (error) {
    // 不吞掉：迁移失败意味着明文可能还在盘上，设置页与诊断都要能看到。
    const message = describeError(error)
    legacyKeyMigrationWarning = {
      code: 'LEGACY_KEY_NOT_MIGRATED',
      message,
      at: new Date().toISOString()
    }
    log('[secrets] 旧密钥迁移失败，settings.json 保持原样：', message)
  }
}

/**
 * 装配加密仓库。
 *
 * 必须在 app.whenReady() 之后：safeStorage 在此之前调用会抛错。
 * 装配失败不阻断启动 —— 桌宠本身还能用，密钥相关 IPC 会明确报错，
 * 不静默退回明文，也不假装成功。
 */
async function initVault() {
  try {
    vault = await createVault({
      keyFilePath: vaultKeysPath,
      safeStorage: {
        isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
        getSelectedStorageBackend: () =>
          typeof safeStorage.getSelectedStorageBackend === 'function'
            ? safeStorage.getSelectedStorageBackend()
            : 'unknown',
        encryptString: (plain) => safeStorage.encryptString(plain),
        decryptString: (encrypted) => safeStorage.decryptString(Buffer.from(encrypted))
      },
      stateFilePath: vaultStatePath,
      appVersion: app.getVersion()
    })

    const client = new VaultClient(new MemoryVaultStorage(), new AesGcmProvider(), vault.ring)
    vaultClient = client
    const store = new KeyRingVaultStore({
      client,
      storage: {
        read: async () => {
          try {
            return await fs.readFile(secretsPath, 'utf8')
          } catch {
            return null
          }
        },
        write: async (text) => {
          await fs.writeFile(secretsPath, text, 'utf8')
          await restrictPermissions(secretsPath)
        },
        // 先写临时文件再替换，断电不会留下半截密文。
        writeAtomic: async (text) => {
          const temp = `${secretsPath}.tmp`
          await fs.writeFile(temp, text, 'utf8')
          await restrictPermissions(temp)
          await fs.rename(temp, secretsPath)
          await restrictPermissions(secretsPath)
        }
      }
    })

    secretStore = new VaultServiceSecretStore(store)
    await migrateLegacySettingsKey(secretStore)
    const diagnostic = await vault.diagnose()
    log(
      'vault 已装配：',
      `backend=${diagnostic.backend}`,
      `secure=${String(diagnostic.secure)}`,
      `permission=${diagnostic.permission}`,
      `keyRing=${diagnostic.keyRingState}`,
      `signer=${diagnostic.signerState}`
    )

    // 首次安装也会 rebuilt，只有「旧数据文件还在」才值得提醒；否则只是新生成密钥。
    if (diagnostic.keyRingState === 'quarantined') {
      vaultStartupNotice = {
        kind: 'quarantined',
        message: '加密密钥文件损坏，已隔离并重新生成。旧记忆可能打不开，可到「设置 → 运行状态 → 加密备份」用备份恢复。'
      }
      log('[vault] 密钥文件已隔离重建', diagnostic.recoveredFrom ?? '')
    } else if (diagnostic.keyRingState === 'rebuilt' && (await hasVaultDataFiles())) {
      vaultStartupNotice = {
        kind: 'rebuilt',
        message: '加密密钥缺失，已重新生成。旧记忆可能打不开，可到「设置 → 运行状态 → 加密备份」用备份恢复。'
      }
      log('[vault] 密钥环重建，且本机仍有旧数据文件')
    }

    const memoryLoaded = await memoryStore.load()
    log('记忆已加载：', JSON.stringify(memoryLoaded))

    const historyLoaded = await chatHistoryStore.load()
    const restored = chatService.hydrate(chatHistoryStore.recent(200))
    log('聊天历史已加载：', JSON.stringify({ ...historyLoaded, restored }))
  } catch (error) {
    vault = null
    vaultClient = null
    secretStore = null
    // 加密不可用时不保留任何明文副本，统计里也会如实显示「不可用」。
    memoryStore.disable()
    chatHistoryStore.disable()
    log('vault 装配失败：', error instanceof Error ? error.message : String(error))
  }
}

function requireSecretStore() {
  if (secretStore === null) {
    throw new Error('VAULT_UNAVAILABLE：加密仓库没有装配成功，拒绝以明文替代')
  }
  return secretStore
}

/**
 * 状态条采样开关。
 *
 * 采样器每 6 秒拉一次 PowerShell 读网速 / 电量，还要试 nvidia-smi。
 * 状态条默认关闭，就不该让这套子进程常驻；打开或关掉时即时生效。
 */
function syncHudSampler() {
  const enabled = settings?.showHud === true && settings?.hudDetail !== 'off'
  if (enabled) void systemStats.start()
  else systemStats.stop()
}

/**
 * 设置变更广播给所有窗口；主界面靠它即时更新气泡 / HUD，不必重启。
 */
function broadcastSettings(next) {
  for (const target of [win, settingsWin, chatWin]) {
    if (target !== null && !target.isDestroyed()) {
      target.webContents.send('pet:settings:changed', next)
    }
  }
  // 开关与间隔都从这里即时生效；settings 已经是合并后的新值。
  syncBalanceMonitor()
  syncHudSampler()
  scheduleGatewaySync()
}

/** 读同步偏好；文件不存在或损坏时回一份空配置，不抛错中断启动。 */
async function getSyncPrefs() {
  if (syncPrefsCache !== null) return syncPrefsCache
  try {
    const parsed = JSON.parse(await fs.readFile(syncPrefsFile, 'utf8'))
    syncPrefsCache = {
      dir: typeof parsed?.dir === 'string' ? parsed.dir : '',
      lastExportAt: typeof parsed?.lastExportAt === 'string' ? parsed.lastExportAt : '',
      lastPullAt: typeof parsed?.lastPullAt === 'string' ? parsed.lastPullAt : ''
    }
  } catch {
    syncPrefsCache = { dir: '', lastExportAt: '', lastPullAt: '' }
  }
  return syncPrefsCache
}

async function saveSyncPrefs(next) {
  const current = await getSyncPrefs()
  syncPrefsCache = { ...current, ...next }
  await fs.writeFile(syncPrefsFile, JSON.stringify(syncPrefsCache), 'utf8')
  await restrictPermissions(syncPrefsFile)
}

/**
 * 建 / 重建同步实例。目录优先级：设置页选过的 > PET_SYNC_DIR > userData/sync。
 * 换目录只换实例，不改 settings，也不动已导出的旧包。
 */
async function initSettingsSync() {
  const prefs = await getSyncPrefs()
  const dir =
    prefs.dir !== '' ? prefs.dir : (devEnv('PET_SYNC_DIR') || path.join(userData, 'sync'))
  settingsSync = createSettingsSync({
    dir,
    node: devEnv('PET_SYNC_NODE', 'desktop-local'),
    readSettings: () => settings,
    // 惰性读取：建 sync 时 vault 还没装好，真正 publish/pull 时才会走到这里。
    getPassphrase: async () => {
      if (secretStore === null) return null
      return await secretStore.get(SYNC_SECRET_SERVICE, SYNC_SECRET_FIELD)
    },
    applySettings: async (patch) => {
      settings = mergeLayer(settings, patch)
      await writeSettings(settings)
      broadcastSettings(settings)
    },
    log
  })
  return settingsSync
}

/**
 * pet-media://<host>/<相对路径> → 对应根目录下的真实文件。
 * 三个 host：
 *   model → mediaRoot（userData/models，Live2D 模型）
 *   asset → assetsRoot（随包表情与立绘）
 *   pack  → packsRoot（用户导入）或内置包根（builtin- 前缀）
 * 解析后必须仍在对应根内 —— 挡住 ../ 穿越读别处的文件。
 */
function registerMediaProtocol() {
  const roots = { model: mediaRoot, asset: assetsRoot, pack: packsRoot }

  protocol.handle('pet-media', async (request) => {
    let target
    let root
    let viaPackStore = false
    try {
      const url = new URL(request.url)
      root = roots[url.host]
      if (root === undefined) {
        log('[media] 拒绝未知前缀请求', request.url)
        return new Response('not found', { status: 404 })
      }
      const relative = decodeURIComponent(url.pathname).replace(/^[/\\]+/, '')
      if (relative === '' || relative.includes('\0')) {
        return new Response('not found', { status: 404 })
      }
      // pack 路径交给 packStore：内置包落在另一个根，由它按 id 前缀分流并做边界校验。
      if (url.host === 'pack') {
        const slash = relative.indexOf('/')
        if (slash <= 0) return new Response('not found', { status: 404 })
        const packId = relative.slice(0, slash)
        const resolved = packStore.resolvePackPath(packId, relative.slice(slash + 1))
        if (resolved === null) {
          log('[media] 拒绝越界包请求', request.url)
          return new Response('forbidden', { status: 403 })
        }
        target = resolved
        viaPackStore = true
      } else {
        target = path.resolve(root, relative)
      }
    } catch {
      return new Response('bad request', { status: 400 })
    }

    if (!viaPackStore) {
      const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep
      if (target !== root && !target.startsWith(rootWithSep)) {
        log('[media] 拒绝越界请求', request.url)
        return new Response('forbidden', { status: 403 })
      }
      // 词法检查挡不住 junction / symlink：Windows 上 mklink /J 建的目录，
      // path.resolve 完全看不出它指向哪里。解析真实路径后再比一次。
      try {
        const [realRoot, realTarget] = await Promise.all([fs.realpath(root), fs.realpath(target)])
        const realRootWithSep = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep
        if (realTarget !== realRoot && !realTarget.startsWith(realRootWithSep)) {
          log('[media] 拒绝软链接越界请求', request.url)
          return new Response('forbidden', { status: 403 })
        }
        target = realTarget
      } catch (error) {
        log('[media] 路径解析失败', request.url, String(error))
        return new Response('not found', { status: 404 })
      }
    }

    try {
      return await net.fetch(pathToFileURL(target).toString())
    } catch (error) {
      log('[media] 读取失败', target, String(error))
      return new Response('not found', { status: 404 })
    }
  })

  log('[media] pet-media://model →', mediaRoot)
  log('[media] pet-media://asset →', assetsRoot)
  log('[media] pet-media://pack →', packsRoot)
}

/**
 * 所有已注册通道。诊断用 registered 报告真实注册面，门禁脚本拿它和白名单比对。
 * 未登记的通道在这里直接抛错，避免「能调但不在清单里」的灰通道。
 */
const registeredChannels = new Set()

function registerChannel(channel, listener) {
  assertChannel(channel)
  if (registeredChannels.has(channel)) {
    throw new Error(`IPC 通道重复注册：${channel}`)
  }
  registeredChannels.add(channel)
  ipcMain.handle(channel, listener)
}

function registerIpc() {
  // 无副作用查询通道集中注册；写操作仍留在下方，阶段二再迁 ipc/mutations.ts。
  registerQueryChannels({
    registerChannel,
    getSettings: () => settings,
    getLastRenderInfo: () => lastRenderInfo,
    modelStore,
    packStore,
    assetLibrary,
    systemStats,
    presenceService,
    chatService,
    chatHistoryStore,
    memoryStore,
    memoryEnabled,
    collectMemoryAll,
    requireSecretStore,
    getSecretStore: () => secretStore,
    getVault: () => vault,
    buildPersonaPrompt,
    getBackupPrefs,
    fs,
    path,
    app,
    userData,
    reportsDir,
    balanceService: BALANCE_SERVICE,
    balanceField: BALANCE_FIELD,
    syncSecretService: SYNC_SECRET_SERVICE,
    syncSecretField: SYNC_SECRET_FIELD,
    defaultSettings: DEFAULT_SETTINGS,
    probeTtsEndpoint,
    toTtsEndpoint,
    isLoopbackEndpoint,
    now: Date.now,
    log
  })

  // 资产与备份域的写操作；其余写通道仍在下方，按域继续迁。
  const mutationDeps = {
    registerChannel,
    dialog,
    getDialogParent: () =>
      settingsWin !== null && !settingsWin.isDestroyed()
        ? settingsWin
        : win !== null && !win.isDestroyed()
          ? win
          : undefined,
    packStore,
    getSettings: () => settings,
    setSettings: (next) => {
      settings = next
    },
    settingsPath,
    sanitizeSettingsPatch,
    mergeLayer,
    settingsTopKeys: SETTINGS_TOP_KEYS,
    // 设置写盘走 writeSettings：原子替换 + 保留上一份 .bak。
    // 调用方按 (file, value) 传参；设置只有一个目标文件，忽略 file、只取 value。
    writeJson: (_file, value) => writeSettings(value),
    applyIconSettings,
    broadcastSettings,
    getBackupPrefs,
    saveBackupPrefs,
    getAppPath: (name) => app.getPath(name),
    getVault: () => vault,
    createVaultBackup,
    readBackupFiles,
    restrictPermissions,
    fs,
    path,
    log
  }
  registerMutationChannels(mutationDeps)

  /** 最近一次因用户动作查到的余额；只用于日报，不主动发起请求。 */
  let lastKnownBalance = null
  // ---- 语音 ----
  // 合成与参考音频选择；软持有生命周期在 voice.ts 内按 sender 维护。
  registerVoiceChannels({
    registerChannel,
    getSettings: () => settings,
    planSpeak,
    createLocalTtsProvider,
    dialog,
    log
  })

  // 设置同步：导出 / 应用 / 目录 / 口令，实现已迁到 ipc/sync.ts。
  registerSyncChannels({
    registerChannel,
    dialog,
    getSettingsSync: () => settingsSync,
    initSettingsSync,
    getSyncPrefs,
    saveSyncPrefs,
    requireSecretStore: () => requireSecretStore(),
    syncSecretService: SYNC_SECRET_SERVICE,
    syncSecretField: SYNC_SECRET_FIELD,
    // 与渲染侧 backup-policy.js 的 PASSPHRASE_MIN_LENGTH 对齐。
    minPassphraseLength: 8,
    log
  })


  // ---- Live2D 模型库 ----  //
  // 模型文件不随包分发，全部由使用者自己从作者处下载后导入，放在 userData/models。
  // 渲染侧只拿 pet-media:// 相对地址，拿不到真实路径。






  // 模型库写操作已迁到 ipc/models.ts。
  registerModelChannels({
    registerChannel,
    dialog,
    getDialogParent: () =>
      settingsWin !== null && !settingsWin.isDestroyed()
        ? settingsWin
        : win !== null && !win.isDestroyed()
          ? win
          : undefined,
    modelStore,
    mediaRoot,
    openPath: (target) => shell.openPath(target),
    getSettings: () => settings,
    setSettings: (next) => {
      settings = next
    },
    settingsPath,
    // 设置写盘走 writeSettings：原子替换 + 保留上一份 .bak。
    // 调用方按 (file, value) 传参；设置只有一个目标文件，忽略 file、只取 value。
    writeJson: (_file, value) => writeSettings(value),
    broadcastSettings,
    log
  })

  // ---- 素材包：用户导入的字体 / 图标 / 气泡 / 表情 ----
  // 只列 userData/packs，不碰 assets/；失败原因原样回渲染侧，界面不猜。


  // 素材包写操作已迁到 ipc/mutations.ts。

  // 查 DeepSeek 账户余额。Key 只在这里读一次，用完即弃，不回传、不写日志。
  // 端点写死在文件顶部，渲染侧没法指定别的地址。
  registerChannel('pet:balance:query', async () => {
    let snapshot = null
    try {
      snapshot = await fetchBalanceSnapshot()
    } catch (error) {
      return {
        ok: false,
        reason: error?.code ?? 'request-failed',
        message: String(error?.message ?? error)
      }
    }

    try {
      const ledger = await ensureBalanceStore().recordBalance(snapshot)
      lastKnownBalance = snapshot.balance
      return {
        ok: true,
        isAvailable: snapshot.isAvailable,
        currency: snapshot.currency,
        totalBalance: snapshot.balance,
        grantedBalance: snapshot.grantedBalance,
        toppedUpBalance: snapshot.toppedUpBalance,
        // v1 切片只保留最新余额；今日消费估算等 c 刀把 opening 并入切片后再恢复。
        todaySpent: null,
        slices: readSlices(ledger)
      }
    } catch (error) {
      return {
        ok: false,
        reason: error?.code ?? 'ledger-write-failed',
        message: String(error?.message ?? error)
      }
    }
  })

  // 余额气泡的「知道了」。只认 v1 segment，避免渲染侧往 acks 里写任意键。
  // 将来系统通知的 tap 也走这条通道，不另建 ack 键。
  registerChannel('pet:balance:ack', async (_event, segment) => {
    if (typeof segment !== 'string' || !/^v1@\d{4}-\d{2}-\d{2}@-?\d+(?:\.\d+)?$/.test(segment)) {
      return { ok: false, reason: 'invalid-segment' }
    }
    try {
      await ensureBalanceStore().markAck(segment, 'confirmed')
      return { ok: true }
    } catch (error) {
      return { ok: false, reason: error?.code ?? 'ack-failed' }
    }
  })

  // ---- 聊天 ----
  // 历史只存在内存里；密钥现取现用，不回传渲染侧。
  // 失败原因用 reason 表达，界面按它写清楚，不把错误吞成「出错了」。
  // 写通道已迁到 ipc/chat.ts，通道层只透传；落盘由 chatService 内部负责。
  registerChatChannels({
    registerChannel,
    getChatService: () => chatService,
    openChatWindow,
    showSaveDialog: (options) => dialog.showSaveDialog(options),
    getDocumentsPath: () => app.getPath('documents'),
    pathJoin: path.join,
    fs: {
      writeFile: (file, data, encoding) =>
        encoding === undefined ? fs.writeFile(file, data) : fs.writeFile(file, data, encoding),
      restrictPermissions
    },
    log
  })

  registerChannel('pet:chat:close', () => {
    if (chatWin !== null && !chatWin.isDestroyed()) chatWin.close()
    return true
  })


  /** 搜索与导出要跨页取全量；单页 500，最多 40 轮，避免异常数据把循环拖住。 */
  function collectMemoryAll() {
    const all = []
    let offset = 0
    for (let round = 0; round < 40; round += 1) {
      const page = memoryStore.list({ offset, limit: 500 })
      const items = Array.isArray(page?.items) ? page.items : []
      all.push(...items)
      offset += items.length
      if (items.length === 0 || offset >= (Number(page?.total) || 0)) break
    }
    return all
  }

  /** 分页读取记忆内容已迁到 ipc/queries.ts，这里保留写导出共用的全量收集。 */

  // 记忆域写通道已迁到 ipc/memory.ts。
  registerMemoryChannels({
    registerChannel,
    memoryStore,
    collectMemoryAll,
    sanitizeReflectionText,
    dialog,
    documentsDir: app.getPath('documents'),
    pathJoin: (...parts) => path.join(...parts),
    writeFile: (file, data, encoding) => fs.writeFile(file, data, encoding),
    log
  })

  // ---- 每日巡视与反思 ----
  // 日报只汇总当天已有的数据；反思在日报之上压成三条印象。
  // 定时器受 companion.care.dailyReview 控制；手动触发不受开关限制。
  async function currentMemoryBaseline() {
    const today = localDateKey()
    const state = await readJson(dailyStatePath, null)
    if (state !== null && state?.date === today && Number.isFinite(state?.memoryStart)) {
      return Math.max(0, Math.floor(state.memoryStart))
    }
    const start = memoryStore.stats().count
    await writeJson(dailyStatePath, { date: today, memoryStart: start })
    return start
  }

  async function runDailyReviewOnce() {
    const memoryBefore = await currentMemoryBaseline()
    const review = buildDailyReview({
      turns: chatService.history(),
      memoryBefore,
      memoryAfter: memoryStore.stats().count,
      balance: lastKnownBalance
    })
    const summary = renderSummary(review)
    try {
      const reportPath = await writeDailyReview({ fs, path, dir: reportsDir, review })
      return { ok: true, review, summary, reportPath }
    } catch (error) {
      log('[daily] 报告写入失败：', String(error))
      return { ok: false, reason: 'write-failed', review, summary }
    }
  }

  // 定时器只拿执行入口，不直接持有 IPC 闭包。
  dailyReviewRunner = runDailyReviewOnce

  registerChannel('pet:daily:run', async () => {
    const result = await runDailyReviewOnce()
    if (result.ok) sendBubble(result.summary)
    return result
  })

  // 点亮一下：优先让模型结合此刻说一句，没密钥 / 调不通时返回本地短句。
  registerChannel('pet:presence:speak', async (_event, reason) => {
    if (settings?.presence?.aiEnabled !== true) return { ok: false, reason: 'disabled' }
    presenceService.noteContact()
    const result = await presenceService.nextLine(typeof reason === 'string' ? reason : 'manual')
    if (typeof result.line === 'string' && result.line !== '') sendBubble(result.line, result.motion)
    return result
  })


  registerChannel('pet:reflection:run', async () => {
    const result = await runDailyReviewOnce()
    const impressions = buildReflection({ review: result.review })
    const markdown = renderReflectionMarkdown({
      date: result.review.date,
      impressions,
      summary: result.summary
    })
    try {
      const filePath = await writeReflection({
        fs,
        path,
        dir: reflectionDir,
        date: result.review.date,
        markdown
      })
      return { ok: true, date: result.review.date, impressions, filePath }
    } catch (error) {
      log('[reflection] 写入失败：', String(error))
      return { ok: false, reason: 'write-failed' }
    }
  })


  // 设置保存写通道已迁到 ipc/mutations.ts。

  /**
   * 鼠标穿透：默认关，只在调试口 / 将来的托盘开关里调用。
   * 本轮不设设置页 UI —— 开了以后点不到桌宠，必须先想清楚怎么关回来。
   */
  registerChannel('pet:window:setClickThrough', (_event, enabled) => {
    const value = Boolean(enabled)
    win?.setIgnoreMouseEvents(value, { forward: true })
    return value
  })

  registerChannel('pet:window:setAlwaysOnTop', (_event, enabled) => {
    const value = Boolean(enabled)
    win?.setAlwaysOnTop(value)
    return value
  })

  registerChannel('pet:settings:open', (_event, payload) => {
    openSettingsWindow(payload?.panel)
    return true
  })

  registerChannel('pet:qq:status', () => {
    return {
      enabled: qqRuntime.enabled,
      transport: qqRuntime.transport,
      state: qqRuntime.state,
      reason: qqRuntime.reason,
      queued:
        qq !== null && typeof qq.pendingCount === 'function' ? qq.pendingCount() : 0,
      webhook: {
        listening: qqRuntime.webhookListening,
        port: qqRuntime.webhookPort,
        error: qqRuntime.webhookError
      }
    }
  })

  // 只验证凭据与网关可达性：不发送消息，也不把 token 回传给渲染侧。
  registerChannel('pet:qq:test', async () => {
    const qqSettings = settings.channels?.qq ?? DEFAULT_SETTINGS.channels.qq
    const appId = devEnv('QQ_BOT_APP_ID').trim() || qqSettings.appId
    if (appId.length === 0) return { ok: false, reason: 'missing-app-id' }
    const envSecret = devEnv('QQ_BOT_SECRET').trim()
    const clientSecret =
      envSecret.length > 0 ? envSecret : await readQqClientSecret(qqSettings.credentialRef)
    if (clientSecret.length === 0) return { ok: false, reason: 'missing-secret' }
    try {
      const client = new QqBotApiClient({ appId, clientSecret })
      const gateway = await client.getGatewayUrl()
      let host = ''
      try {
        host = new URL(gateway).host
      } catch {
        host = ''
      }
      return { ok: true, gatewayHost: host, transport: qqSettings.transport }
    } catch (error) {
      return {
        ok: false,
        reason: 'request-failed',
        message: error instanceof Error ? error.message : String(error)
      }
    }
  })

  // 能力中心：独立窗口。窗口本身只读状态与触发动作，不持有额外权限。
  registerChannel('pet:ability:open', () => {
    openAbilityWindow()
    return true
  })

  // 猜拳：出拳 / 查战绩 / 重置共用一条通道，非法输入明确回 bad-choice。
  registerChannel('pet:game:rps', async (_event, payload) => {
    const action = payload?.action
    if (action === 'reset') {
      rpsGame.reset()
      await saveRpsStats()
      return { ok: true, action: 'reset', stats: rpsGame.stats }
    }
    if (action === 'stats') return { ok: true, action: 'stats', stats: rpsGame.stats }
    if (action !== 'play') return { ok: false, reason: 'bad-action' }

    const choice = payload?.choice
    if (choice !== 'rock' && choice !== 'paper' && choice !== 'scissors') {
      return { ok: false, reason: 'bad-choice' }
    }
    const round = rpsGame.play(choice)
    await saveRpsStats()
    return { ok: true, action: 'play', round, stats: rpsGame.stats }
  })

  // 游戏日常：检测 + 排班 + dry-run。内测只到预览，不启动 BetterGI 或计划任务。
  registerChannel('pet:game:detect', () => ensureGameDailyService().detect())
  registerChannel('pet:game:schedule:get', () => ensureGameDailyService().load())
  registerChannel('pet:game:schedule:save', async (_event, config) =>
    ensureGameDailyService().save(config)
  )
  registerChannel('pet:game:dry-run', (_event, config) =>
    ensureGameDailyService().dryRun(config)
  )

  registerChannel('pet:settings:close', () => {
    if (settingsWin !== null && !settingsWin.isDestroyed()) settingsWin.close()
    return true
  })

  // 右键桌宠：原生菜单。
  // 透明无边框窗口里自绘浮层要自己处理层级、越界和失焦关闭，交给系统菜单最省事，
  // 位置也会自动贴着光标。
  //
  // 只留「聊天 / 设置 / 退出」。换模型、打开模型目录都已经在设置窗里，
  // 菜单里再放一份就是两个入口指向同一件事。
  /** 一键回城：拖丢、甩出屏幕后都能把桌宠放回右下角并显示出来。 */
  const dockPetToBottomRight = () => {
    if (win === null || win.isDestroyed()) return false
    const [width, height] = win.getSize()
    win.setBounds(
      dockBoundsToBottomRight({ width, height }, screen.getPrimaryDisplay().workArea)
    )
    win.show()
    win.focus()
    void saveWindowState()
    return true
  }

  registerChannel('pet:menu:context', () => {
    const menu = Menu.buildFromTemplate([
      { label: '聊天…', click: () => openChatWindow() },
      { label: '把桌宠找回来', click: () => dockPetToBottomRight() },
      { label: '设置', click: () => openSettingsWindow('general') },
      { type: 'separator' },
      { label: '退出', click: () => app.quit() }
    ])
    if (win !== null && !win.isDestroyed()) menu.popup({ window: win })
    else menu.popup()
    return true
  })

  // 按当前设置重设主窗口尺寸。保留左上角坐标，否则改缩放时窗口会跳走。
  // 新尺寸仍要夹回工作区：放大后右下角可能顶出屏幕。
  registerChannel('pet:window:applySize', () => {
    if (win === null || win.isDestroyed()) return false
    const next = createWindowOptions(settings, path.join(__dirname, 'preload.cjs'))
    const [x, y] = win.getPosition()
    const bounds = { x, y, width: next.width, height: next.height }
    win.setBounds(clampBoundsToWorkArea(bounds, screen.getDisplayMatching(bounds).workArea))
    void saveWindowState()
    return true
  })

  registerChannel('pet:window:getSize', () => {
    if (win === null || win.isDestroyed()) return null
    const [width, height] = win.getSize()
    return { width, height }
  })

  // 渲染侧状态上报：只在内存里留一份，不落盘，供设置窗诊断读取。
  registerChannel('pet:render:report', (_event, info) => {
    if (typeof info !== 'object' || info === null) return false
    lastRenderInfo = info
    return true
  })


  registerChannel('pet:window:move', (_event, position) => {
    if (win === null || win.isDestroyed()) return false
    if (typeof position !== 'object' || position === null) return false
    // { dock: 'bottom-right' } = 一键归位，渲染侧与托盘「找回窗口」走这里。
    if (position.dock === 'bottom-right') {
      const [w, h] = win.getSize()
      win.setBounds(
        dockBoundsToBottomRight({ width: w, height: h }, screen.getPrimaryDisplay().workArea)
      )
      void saveWindowState()
      return true
    }
    const { x, y } = position
    if (typeof x !== 'number' || typeof y !== 'number') return false
    win.setPosition(Math.round(x), Math.round(y))
    scheduleSaveWindowState()
    return true
  })

  // 拖拽由主进程主导：渲染侧只发「开始 / 结束」。
  // 用增量会让窗口跟手失败 —— 窗口跟着鼠标走时，鼠标相对窗口的位置不变，
  // screenX 也不变，算出 dx=0 就不动了。所以改为按住时记住光标与窗口的偏移，
  // 再由定时器读 getCursorScreenPoint() 反推窗口位置。
  let dragTimer = null
  let flingTimer = null
  // 拖动开始时记下窗口尺寸：Windows 在移动过程中会按 DPI 重新算一次非客户区，
  // 每帧给窗口加 2px；只改位置的话，这点增量会一路累积成「越拖越大」。
  let dragBounds = null

  /** 抛掷：松手时按最后一段轨迹估速，惯性滑行 + 逐帧摩擦，撞到工作区边界反弹。 */
  const stopFling = () => {
    if (flingTimer !== null) {
      clearInterval(flingTimer)
      flingTimer = null
    }
  }

  /** 边缘吸附：距工作区边缘 12px 内直接贴边，由 settings.window.edgeSnap 控制。 */
  const applyEdgeSnap = () => {
    if (win === null || win.isDestroyed()) return
    if (!settings.window.edgeSnap) return
    const SNAP = Math.max(4, Math.min(64, Math.round(settings.window.edgeSnapDistance ?? 12)))
    const area = screen.getDisplayMatching(win.getBounds()).workArea
    const [x, y] = win.getPosition()
    const [w, h] = win.getSize()
    let nextX = x
    let nextY = y
    if (Math.abs(x - area.x) <= SNAP) nextX = area.x
    else if (Math.abs(area.x + area.width - (x + w)) <= SNAP) nextX = area.x + area.width - w
    if (Math.abs(y - area.y) <= SNAP) nextY = area.y
    else if (Math.abs(area.y + area.height - (y + h)) <= SNAP) nextY = area.y + area.height - h
    if (nextX !== x || nextY !== y) win.setPosition(nextX, nextY)
  }

  registerChannel('pet:window:dragStart', () => {
    if (win === null || win.isDestroyed()) return false
    stopFling()
    if (dragTimer !== null) return true
    const cursor = screen.getCursorScreenPoint()
    const [wx, wy] = win.getPosition()
    const offsetX = cursor.x - wx
    const offsetY = cursor.y - wy
    dragBounds = win.getBounds()
    // 拖动期间关掉可缩放：Windows 会按 DPI 重算窗口外框，每帧给宽度加 2px。
    win.setResizable(false)
    dragTimer = setInterval(() => {
      if (win === null || win.isDestroyed()) return
      const point = screen.getCursorScreenPoint()
      const nextX = Math.round(point.x - offsetX)
      const nextY = Math.round(point.y - offsetY)
      if (dragBounds === null) {
        win.setPosition(nextX, nextY)
        return
      }
      const [width, height] = win.getSize()
      // 1px 的偏差先放过：每帧写回会再触发一次 resize，画布跟着重建就是闪。
      // 攒到 2px 以上才连尺寸一起写回，拖动结束再收口。
      const drift = Math.abs(width - dragBounds.width) + Math.abs(height - dragBounds.height)
      if (drift < 2) {
        win.setPosition(nextX, nextY)
      } else {
        win.setBounds({ x: nextX, y: nextY, width: dragBounds.width, height: dragBounds.height })
      }
    }, 16)
    return true
  })

  registerChannel('pet:window:dragEnd', (_event, velocity) => {
    if (dragTimer !== null) {
      clearInterval(dragTimer)
      dragTimer = null
    }
    if (win === null || win.isDestroyed()) return false

    // 先把尺寸收回拖动开始时的值；窗口固定尺寸，不再恢复可缩放。
    if (dragBounds !== null) {
      const [x, y] = win.getPosition()
      win.setBounds({ x, y, width: dragBounds.width, height: dragBounds.height })
      dragBounds = null
    }

    // 先吸附再判速度：慢速松手也要能贴边，而慢速分支会直接返回。
    applyEdgeSnap()

    // 速度单位 px/ms。低速松手直接停住。
    // 原来阈值 0.35 太低：慢慢往左拖一段也会被当成抛掷，松手后继续飘几十像素，
    // 观感就是「滑翔」。提到 0.55 后，只有明确甩出去才给惯性。
    const rawX = typeof velocity?.vx === 'number' ? velocity.vx : 0
    const rawY = typeof velocity?.vy === 'number' ? velocity.vy : 0
    if (!Number.isFinite(rawX) || !Number.isFinite(rawY)) return true
    if (Math.hypot(rawX, rawY) < 0.55) return true

    stopFling()
    let vx = rawX
    let vy = rawY
    const bounds = screen.getDisplayMatching(win.getBounds()).workArea
    const [w, h] = win.getSize()
    // 摩擦 0.92 → 0.84，停止阈值 0.02 → 0.05：同样初速下滑行距离约减半。
    const FRICTION = 0.84
    const STOP = 0.05

    flingTimer = setInterval(() => {
      if (win === null || win.isDestroyed()) {
        stopFling()
        return
      }
      const [x, y] = win.getPosition()
      let nextX = x + vx * 16
      let nextY = y + vy * 16

      // 撞到工作区边界就直接停，不反弹。
      // 反弹会让贴边后来回弹几下，比直接停更像故障，也加重「还在飘」的观感。
      let hitEdge = false
      if (nextX < bounds.x) {
        nextX = bounds.x
        hitEdge = true
      } else if (nextX + w > bounds.x + bounds.width) {
        nextX = bounds.x + bounds.width - w
        hitEdge = true
      }
      if (nextY < bounds.y) {
        nextY = bounds.y
        hitEdge = true
      } else if (nextY + h > bounds.y + bounds.height) {
        nextY = bounds.y + bounds.height - h
        hitEdge = true
      }

      // 和拖动一样：移动过程中系统会偷加 2px，尺寸不一致时连尺寸一起写回。
      const [currentWidth, currentHeight] = win.getSize()
      if (currentWidth === w && currentHeight === h) {
        win.setPosition(Math.round(nextX), Math.round(nextY))
      } else {
        win.setBounds({ x: Math.round(nextX), y: Math.round(nextY), width: w, height: h })
      }
      if (hitEdge) {
        stopFling()
        return
      }

      vx *= FRICTION
      vy *= FRICTION
      if (Math.hypot(vx, vy) < STOP) stopFling()
    }, 16)
    return true
  })

  registerChannel('pet:ask', async (_event, request) => {
    if (typeof request !== 'object' || request === null) {
      throw new Error('决策请求必须是对象')
    }
    const envelope = await gateway.prepare({
      kind: request.kind ?? 'approval',
      summary: String(request.summary ?? ''),
      payload: request.payload,
      ttlMs: typeof request.ttlMs === 'number' ? request.ttlMs : undefined
    })
    void gateway
      .wait(envelope.id)
      .then((outcome) => sendDecision(outcome))
      .catch((error) => sendDecision({ status: 'timeout', envelope, usedFallback: true, error: String(error) }))
    return envelope
  })

  registerChannel('pet:approve', async (_event, request) => {
    if (typeof request !== 'object' || request === null) {
      throw new Error('审批请求必须是对象')
    }
    return gateway.resolve(String(request.id ?? ''), request.action ?? 'dismiss', request.answer)
  })

  // 单条限 8 KiB，整份日志超 2 MiB 轮转为 .1。没有上限时，异常上报能把磁盘写满。
  const MAX_TASK_BYTES = 8 * 1024
  const MAX_TASK_LOG_BYTES = 2 * 1024 * 1024

  registerChannel('pet:reportTask', async (_event, task) => {
    const payloadText = JSON.stringify(task) ?? 'null'
    if (Buffer.byteLength(payloadText, 'utf8') > MAX_TASK_BYTES) {
      return { ok: false, reason: 'task-too-large', limitBytes: MAX_TASK_BYTES }
    }

    try {
      const stat = await fs.stat(taskLogPath)
      if (stat.size >= MAX_TASK_LOG_BYTES) {
        await fs.rm(`${taskLogPath}.1`, { force: true })
        await fs.rename(taskLogPath, `${taskLogPath}.1`)
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') log('[tasks] 检查日志大小失败：', String(error))
    }

    await fs.appendFile(taskLogPath, `${new Date().toISOString()} ${payloadText}\n`, 'utf8')
    return { ok: true }
  })

  // 外部服务密钥的 set / clear 已迁到 ipc/secrets.ts。
  registerSecretChannels({
    registerChannel,
    requireSecretStore,
    onSecretChanged: (serviceId) => {
      // QQ 通道持有解密后的旧 AppSecret；写入/清除后强制重建一次。
      if (serviceId !== QQ_SECRET_SERVICE) return
      void syncGatewayIfNeeded(true).catch((error) =>
        log('[qq] 凭据变更后重建通道失败：', error instanceof Error ? error.message : String(error))
      )
    }
  })

  // ---- 一键备份：目录、保留份数、自动备份节奏存独立小配置 ----
  // 手动备份的口令只在这次调用里出现；自动备份需要用户输入一次，之后用系统密钥
  // 加密保存到 backup-secret.bin，仅当前系统用户可以解开，删掉文件即失效。
  const backupPrefsFile = path.join(userData, 'backup-prefs.json')
  const backupSecretFile = path.join(userData, 'backup-secret.bin')
  let backupPrefsCache = null

  async function getBackupPrefs() {
    if (backupPrefsCache !== null) return backupPrefsCache
    try {
      const parsed = JSON.parse(await fs.readFile(backupPrefsFile, 'utf8'))
      backupPrefsCache = {
        dir: typeof parsed?.dir === 'string' ? parsed.dir : '',
        keep:
          Number.isInteger(parsed?.keep) && parsed.keep >= 1 && parsed.keep <= 100
            ? parsed.keep
            : 5,
        lastRunAt: typeof parsed?.lastRunAt === 'string' ? parsed.lastRunAt : '',
        autoIntervalDays:
          Number.isInteger(parsed?.autoIntervalDays) &&
          parsed.autoIntervalDays >= 0 &&
          parsed.autoIntervalDays <= 365
            ? parsed.autoIntervalDays
            : 0,
        autoLastError: typeof parsed?.autoLastError === 'string' ? parsed.autoLastError : '',
        autoStored: parsed?.autoStored === true
      }
    } catch {
      backupPrefsCache = {
        dir: '',
        keep: 5,
        lastRunAt: '',
        autoIntervalDays: 0,
        autoLastError: '',
        autoStored: false
      }
    }
    return backupPrefsCache
  }

  async function saveBackupPrefs(next) {
    const current = await getBackupPrefs()
    backupPrefsCache = { ...current, ...next }
    await fs.writeFile(backupPrefsFile, JSON.stringify(backupPrefsCache), 'utf8')
    await restrictPermissions(backupPrefsFile)
  }

  async function readAutoPassword() {
    try {
      if (!safeStorage.isEncryptionAvailable()) return ''
      return safeStorage.decryptString(await fs.readFile(backupSecretFile))
    } catch {
      return ''
    }
  }

  async function writeAutoPassword(password) {
    if (!safeStorage.isEncryptionAvailable()) return false
    await fs.writeFile(backupSecretFile, safeStorage.encryptString(password))
    await restrictPermissions(backupSecretFile)
    return true
  }

  registerBackupChannels({
    registerChannel,
    getBackupPrefs,
    getDocumentsPath: () => app.getPath('documents'),
    pathJoin: (...parts) => path.join(...parts),
    pathBasename: (file) => path.basename(file),
    saveBackupPrefs,
    readAutoPassword,
    writeAutoPassword,
    removeAutoSecret: () => fs.rm(backupSecretFile, { force: true }).catch(() => undefined),
    fs: {
      readdir: (dir, options) => fs.readdir(dir, options),
      stat: (file) => fs.stat(file)
    }
  })

  let autoBackupRunning = false
  async function maybeRunAutoBackup() {
    if (autoBackupRunning) return
    const prefs = await getBackupPrefs()
    if (prefs.autoIntervalDays <= 0 || prefs.autoStored !== true) return
    if (vault === null) return
    const password = await readAutoPassword()
    if (password.length < 8) return
    const last = prefs.lastRunAt === '' ? 0 : Date.parse(prefs.lastRunAt)
    const base = Number.isFinite(last) ? last : 0
    if (Date.now() - base < prefs.autoIntervalDays * 86400000) return

    autoBackupRunning = true
    try {
      const result = await runBackup(mutationDeps, { password })
      if (result?.ok === true) {
        await saveBackupPrefs({ autoLastError: '' })
        log('[backup] 自动备份完成', `file=${result.fileName}`)
      } else {
        const message = result?.message ?? result?.reason ?? '备份失败'
        await saveBackupPrefs({ autoLastError: message })
        log('[backup] 自动备份失败：', message)
      }
    } catch (error) {
      const message = describeError(error)
      await saveBackupPrefs({ autoLastError: message }).catch(() => undefined)
      log('[backup] 自动备份异常：', message)
    } finally {
      autoBackupRunning = false
    }
  }

  // 启动后给一分钟缓冲，之后每六小时看一次；是否到期由 lastRunAt 与间隔决定。
  const autoBackupTimer = setInterval(() => void maybeRunAutoBackup(), 6 * 60 * 60 * 1000)
  autoBackupTimer.unref?.()
  const autoBackupKickoff = setTimeout(() => void maybeRunAutoBackup(), 60 * 1000)
  autoBackupKickoff.unref?.()

  // 备份目录轮换与命名已随写通道迁到 ipc/mutations.ts。


  // 备份选择目录、保留份数与执行通道已迁到 ipc/mutations.ts。

  // ---- 备份：口令封装，换机可恢复。口令丢了就真丢了，渲染侧必须二次确认 ----
  // 密钥轮换、备份导出与导入已迁到 ipc/vault.ts。
  registerVaultChannels({
    registerChannel,
    getVault: () => vault,
    getVaultClient: () => vaultClient,
    getVaultBackend: () => vault?.backend ?? null,
    getLegacyKeyMigrationWarning: () => legacyKeyMigrationWarning,
    cryptoSuite: new AesGcmProvider().suite,
    showOpenDialog: (options) => dialog.showOpenDialog(options),
    showSaveDialog: (options) => dialog.showSaveDialog(options),
    getDocumentsPath: () => app.getPath('documents'),
    pathBasename: (file) => path.basename(file),
    createVaultBackup,
    readBackupFiles,
    fs: {
      readFile: (file, encoding) => fs.readFile(file, encoding),
      writeFile: (file, data) => fs.writeFile(file, data),
      mkdir: (dir, options) => fs.mkdir(dir, options),
      copyFile: (from, to) => fs.copyFile(from, to)
    },
    pathJoin: (...parts) => path.join(...parts),
    userData,
    vaultKeysPath,
    backupFiles: BACKUP_FILES,
    writeRestoredKeyRing,
    openVaultBackup,
    restrictPermissions,
    disableMemory: () => memoryStore.disable(),
    disableChatHistory: () => chatHistoryStore.disable(),
    markMemoryFlushed: () => {
      memoryFlushed = true
    },
    scheduleRestart: () => {
      setTimeout(() => {
        app.relaunch()
        app.quit()
      }, 800)
    },
    describeError,
    log
  })

  registerDiagnosticsChannels({
    registerChannel,
    getAppVersion: () => app.getVersion(),
    listIpcChannels: () => IPC_CHANNELS,
    getRegisteredChannels: () => [...registeredChannels],
    getPendingDecisionIds: () => gateway.pendingIds,
    getSettings: () => settings,
    getMediaRoot: () => mediaRoot,
    modelStore,
    getQq: () => qq,
    getVault: () => vault,
    getLegacyKeyMigrationWarning: () => legacyKeyMigrationWarning
  })
}

/**
 * 独立设置窗：单例，复用同一个 preload。
 * frame:false 让顶栏自绘，和主窗口观感一致。
 */
function openSettingsWindow(panel) {
  const target = typeof panel === 'string' && panel !== '' ? panel : undefined

  if (settingsWin !== null && !settingsWin.isDestroyed()) {
    // 已经开着就直接切到目标面板，不再叠一个窗口。
    if (target !== undefined) settingsWin.webContents.send('pet:settings:panel', target)
    settingsWin.show()
    settingsWin.focus()
    return
  }

  settingsWin = new BrowserWindow({
    width: 600,
    height: 740,
    icon: appIconPath,
    minWidth: 520,
    minHeight: 560,
    resizable: true,
    frame: false,
    backgroundColor: '#fffafc',
    show: false,
    skipTaskbar: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  settingsWin.once('ready-to-show', () => {
    if (settingsWin !== null && !settingsWin.isDestroyed()) settingsWin.show()
  })

  settingsWin.on('closed', () => {
    settingsWin = null
  })

  // 设置窗不允许自行开新窗口或跳外链。
  settingsWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  void settingsWin.loadFile(path.join(__dirname, 'renderer', 'settings.html'), {
    ...(target === undefined ? {} : { hash: target }),
    query: { theme: settings.theme?.preset ?? 'SakuraPink' }
  })
}

/**
 * 能力中心：九宫格入口，单例。
 *
 * 和设置窗同一套窗口参数：contextIsolation + sandbox，preload 白名单不变。
 * 页面只调用已登记通道，不开放任何新的宿主能力。
 */
function openAbilityWindow() {
  if (abilityWin !== null && !abilityWin.isDestroyed()) {
    abilityWin.show()
    abilityWin.focus()
    return
  }

  abilityWin = new BrowserWindow({
    width: 680,
    height: 720,
    icon: appIconPath,
    minWidth: 560,
    minHeight: 560,
    resizable: true,
    frame: false,
    backgroundColor: '#fffafc',
    show: false,
    skipTaskbar: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  abilityWin.once('ready-to-show', () => {
    if (abilityWin !== null && !abilityWin.isDestroyed()) abilityWin.show()
  })

  abilityWin.on('closed', () => {
    abilityWin = null
  })

  abilityWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  void abilityWin.loadFile(path.join(__dirname, 'renderer', 'ability.html'), {
    query: { theme: settings.theme?.preset ?? 'SakuraPink' }
  })
}

/**
 * 聊天窗：单例，和设置窗同一套 preload。
 *
 * 默认贴在桌宠旁边；右边放不下就翻到左边，再不行就贴工作区边缘，
 * 免得在多屏或窄屏上开在看不见的地方。
 */
function openChatWindow() {
  if (chatWin !== null && !chatWin.isDestroyed()) {
    chatWin.show()
    chatWin.focus()
    return
  }

  const width = 380
  const height = 520
  const bounds = win === null || win.isDestroyed() ? null : win.getBounds()
  const area = (bounds === null ? screen.getPrimaryDisplay() : screen.getDisplayMatching(bounds)).workArea

  const right = bounds === null ? area.x + area.width - width - 24 : bounds.x + bounds.width + 8
  const left = bounds === null ? area.x + 24 : bounds.x - width - 8
  const x = right + width <= area.x + area.width ? right : Math.max(area.x + 8, left)
  const y = Math.min(
    Math.max(bounds === null ? area.y + 80 : bounds.y, area.y + 8),
    Math.max(area.y + 8, area.y + area.height - height - 8)
  )

  chatWin = new BrowserWindow({
    x,
    y,
    width,
    height,
    minWidth: 320,
    minHeight: 400,
    icon: appIconPath,
    resizable: true,
    frame: false,
    backgroundColor: '#fffafc',
    show: false,
    skipTaskbar: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  chatWin.once('ready-to-show', () => {
    if (chatWin !== null && !chatWin.isDestroyed()) chatWin.show()
  })

  chatWin.on('closed', () => {
    chatWin = null
  })

  // 聊天内容全是文本，没有外链需求；一律拒绝新窗口。
  chatWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  void chatWin.loadFile(path.join(__dirname, 'renderer', 'chat.html'), {
    query: { theme: settings.theme?.preset ?? 'SakuraPink' }
  })
}

/**
 * 首次引导窗：只在 onboarded 为 false 时出现。
 * 中途关掉不算走完，下次启动还会问；三步都过一遍才写 onboarded: true。
 */
function openOnboardingWindow() {
  if (onboardingWin !== null && !onboardingWin.isDestroyed()) {
    onboardingWin.show()
    onboardingWin.focus()
    return
  }

  onboardingWin = new BrowserWindow({
    width: 460,
    height: 520,
    icon: appIconPath,
    resizable: false,
    frame: false,
    backgroundColor: '#fffafc',
    show: false,
    skipTaskbar: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  onboardingWin.once('ready-to-show', () => {
    if (onboardingWin !== null && !onboardingWin.isDestroyed()) onboardingWin.show()
  })

  onboardingWin.on('closed', () => {
    onboardingWin = null
  })

  onboardingWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  void onboardingWin.loadFile(path.join(__dirname, 'renderer', 'onboarding.html'), {
    query: { theme: settings.theme?.preset ?? 'SakuraPink' }
  })
}

/**
 * 托盘静音开关：写的是 settings.voice.enabled，和设置页同一个字段。
 * 保存失败时要能看出来，所以只记录不吞掉。
 */
async function setVoiceMuted(muted) {
  settings = mergeLayer(settings, { voice: { enabled: !muted } })
  try {
    await writeSettings(settings)
    broadcastSettings(settings)
  } catch (error) {
    log('[tray] 静音设置保存失败：', error?.message ?? error)
  }
}

/**
 * 托盘边缘吸附开关：写 settings.window.edgeSnap，和设置页同一个字段。
 * 吸附在拖动结束时判断，保存后下一次拖动即生效。
 */
async function setEdgeSnap(enabled) {
  const prev = settings
  settings = mergeLayer(settings, { window: { edgeSnap: enabled } })
  try {
    await writeSettings(settings)
    broadcastSettings(settings)
    flashTrayTip(enabled ? '已开启边缘吸附' : '已关闭边缘吸附')
  } catch (error) {
    // 写盘失败就回滚，菜单勾选保持原样。
    settings = prev
    log('[tray] 边缘吸附设置保存失败：', error?.message ?? error)
    flashTrayTip('边缘吸附设置保存失败')
  }
}

/**
 * 临时安静：只存在于本次运行，不写设置。
 * 到点自动恢复；重启进程也会恢复，和「临时」的语义一致。
 */
let quietUntil = 0
let quietTimer = null
let quietTickTimer = null
// 托盘菜单构建器由 createTray 注入：startQuiet 在模块顶层，不能直接引用 createTray 的局部函数。
let trayMenuBuilder = null

function quietMinutesLeft() {
  if (quietUntil === 0) return 0
  return Math.max(0, Math.ceil((quietUntil - Date.now()) / 60_000))
}

function quietTipText() {
  return `安静中 · 还剩 ${quietMinutesLeft()} 分钟`
}

/** 安静状态变化后统一刷新托盘：菜单标签与 tooltip 都跟着走。 */
function refreshTrayQuietUi() {
  if (tray === null || tray.isDestroyed()) return
  if (trayMenuBuilder !== null) tray.setContextMenu(trayMenuBuilder())
  tray.setToolTip(isTemporarilyQuiet() ? quietTipText() : '桌宠')
}

function isTemporarilyQuiet() {
  if (quietUntil === 0) return false
  if (Date.now() >= quietUntil) {
    quietUntil = 0
    return false
  }
  return true
}

function stopQuiet() {
  quietUntil = 0
  if (quietTimer !== null) {
    clearTimeout(quietTimer)
    quietTimer = null
  }
  if (quietTickTimer !== null) {
    clearInterval(quietTickTimer)
    quietTickTimer = null
  }
}

function startQuiet(minutes) {
  stopQuiet()
  const duration = Math.max(1, Math.round(minutes)) * 60_000
  quietUntil = Date.now() + duration
  quietTimer = setTimeout(() => {
    quietUntil = 0
    quietTimer = null
    if (quietTickTimer !== null) {
      clearInterval(quietTickTimer)
      quietTickTimer = null
    }
    refreshTrayQuietUi()
    flashTrayTip('安静时间结束了')
  }, duration)
  quietTimer.unref?.()
  // 菜单打开时不会自己重算，安静期间每 30 秒重建一次，倒计时才跟得上。
  quietTickTimer = setInterval(refreshTrayQuietUi, 30_000)
  quietTickTimer.unref?.()
  refreshTrayQuietUi()
  flashTrayTip(`安静 ${minutes} 分钟`)
}

/**
 * 托盘是当前唯一的可见退出入口：窗口 frame:false 且 skipTaskbar:true，
 * 没有托盘就只能靠任务管理器结束进程。
 */
function flashTrayTip(text) {
  if (tray === null || tray.isDestroyed()) return
  tray.setToolTip(text)
  setTimeout(() => {
    if (tray === null || tray.isDestroyed()) return
    tray.setToolTip(isTemporarilyQuiet() ? quietTipText() : '桌宠')
  }, 4000)
}

/**
 * 把 settings 里的 pack:<id>:<相对路径> 解析成真实文件。
 * 只认这个格式，其它写法（含绝对路径）一律当空值处理。
 */
function resolvePackAssetRef(ref) {
  if (typeof ref !== 'string') return null
  if (!ref.startsWith('pack:')) return null
  const rest = ref.slice('pack:'.length)
  const sep = rest.indexOf(':')
  if (sep <= 0) return null
  const packId = rest.slice(0, sep)
  const relative = rest.slice(sep + 1)
  if (relative === '') return null
  return packStore.resolvePackPath(packId, relative)
}

/**
 * 托盘图标候选顺序：素材包选中项 → Cyrene 自绘 ico → 旧的 tray.png。
 * ico 在个别 Windows 环境下解不出来，回退一次比直接留空托盘更好。
 */
function loadTrayIcon() {
  const candidates = []
  const picked = resolvePackAssetRef(settings.icon?.tray)
  if (picked !== null) candidates.push(picked)
  candidates.push(
    path.join(assetsRoot, 'cyrene', 'icons', 'tray.ico'),
    path.join(__dirname, 'assets', 'tray.png')
  )
  for (const candidate of candidates) {
    const image = nativeImage.createFromPath(candidate)
    if (!image.isEmpty()) return image
    log('托盘图标不可用：', candidate)
  }
  return null
}

/** 窗口与任务栏图标：素材包选中项优先，回退内置 app-cyrene.png。 */
function resolveAppIcon() {
  const picked = resolvePackAssetRef(settings.icon?.app)
  if (picked !== null) {
    const image = nativeImage.createFromPath(picked)
    if (!image.isEmpty()) return image
    log('素材包窗口图标不可用：', picked)
  }
  const fallback = nativeImage.createFromPath(appIconPath)
  return fallback.isEmpty() ? null : fallback
}

/**
 * 图标设置变更后调用：换托盘图 + 给所有存活窗口重设图标。
 * 托盘读取失败时保留旧图标，不能让它凭空消失。
 * 没换图标引用时直接返回，避免每次保存设置都读一遍图片。
 */
let lastIconSignature = null
function applyIconSettings(force = false) {
  const signature = `${settings.icon?.tray ?? ''}|${settings.icon?.app ?? ''}`
  if (!force && signature === lastIconSignature) return
  lastIconSignature = signature

  if (tray !== null && !tray.isDestroyed()) {
    const image = loadTrayIcon()
    if (image !== null) tray.setImage(image)
  }

  const icon = resolveAppIcon()
  if (icon === null) return
  for (const target of [win, settingsWin, chatWin, abilityWin, onboardingWin]) {
    if (target === null || target === undefined || target.isDestroyed()) continue
    try {
      target.setIcon(icon)
    } catch (error) {
      log('窗口图标更新失败：', String(error))
    }
  }
}

function createTray() {
  const icon = loadTrayIcon()
  if (icon === null) {
    log('托盘图标全部读取失败，跳过托盘创建')
    return
  }

  tray = new Tray(icon)
  tray.setToolTip('桌宠')

  // 每次重建菜单：勾选状态必须来自当前 settings，不能只改文案。
  trayMenuBuilder = () =>
    Menu.buildFromTemplate([
      {
        label: '显示窗口',
        click: () => {
          if (win === null || win.isDestroyed()) return
          win.show()
          win.focus()
        }
      },
      {
        // 窗口落到屏幕外时的回城入口；正常只要显示窗口就够了。
        label: '找回窗口',
        click: () => recoverWindow()
      },
      {
        label: '开机自启',
        type: 'checkbox',
        checked: loginItemEnabled(),
        click: () => {
          setLoginItem(!loginItemEnabled())
          tray?.setContextMenu(trayMenuBuilder())
        }
      },
      {
        label: '聊天',
        click: () => {
          openChatWindow()
        }
      },
      {
        label: '能力中心',
        click: () => {
          openAbilityWindow()
        }
      },
      {
        label: '每日巡视',
        click: () => {
          void runDailyReviewOnce()
        }
      },
      {
        label: '静音',
        type: 'checkbox',
        checked: settings.voice?.enabled === false,
        click: () => {
          const nextMuted = settings.voice?.enabled !== false
          void setVoiceMuted(nextMuted).finally(() => {
            tray?.setContextMenu(trayMenuBuilder())
          })
        }
      },
      {
        // 临时安静覆盖主动台词与提醒；声音的常驻静音是另一项，互不替代。
        label: isTemporarilyQuiet() ? quietTipText() : '安静一会儿',
        submenu: [
          { label: '15 分钟', click: () => startQuiet(15) },
          { label: '30 分钟', click: () => startQuiet(30) },
          { label: '1 小时', click: () => startQuiet(60) },
          { type: 'separator' },
          {
            label: '取消安静',
            enabled: isTemporarilyQuiet(),
            click: () => {
              stopQuiet()
              refreshTrayQuietUi()
              flashTrayTip('已恢复')
            }
          }
        ]
      },
      {
        label: '边缘吸附',
        type: 'checkbox',
        checked: settings.window?.edgeSnap === true,
        click: () => {
          void setEdgeSnap(settings.window?.edgeSnap !== true).finally(() => {
            tray?.setContextMenu(trayMenuBuilder())
          })
        }
      },
      {
        label: '状态栏',
        type: 'checkbox',
        // 勾选态每次重建时从 settings 现读，避免菜单和实际显示不一致。
        checked: settings.showHud === true && settings.hudDetail !== 'off',
        click: async () => {
          const prev = settings
          const nextOn = !(settings.showHud === true && settings.hudDetail !== 'off')
          const patch = nextOn
            ? {
                showHud: true,
                // 老配置里的 off 语义是「关闭」，重新打开时归一到紧凑档。
                hudDetail: settings.hudDetail === 'off' ? 'compact' : settings.hudDetail
              }
            : { showHud: false }
          settings = mergeLayer(settings, patch)
          try {
            await writeSettings(settings)
            broadcastSettings(settings)
          } catch (error) {
            // 写盘失败就回滚，菜单勾选保持原样，不让界面和磁盘各说各话。
            settings = prev
            log('[tray] 状态栏设置保存失败：', error?.message ?? error)
            flashTrayTip('状态栏设置保存失败')
          }
          tray?.setContextMenu(trayMenuBuilder())
        }
      },
      {
        label: '导出同步包',
        enabled: settingsSync !== null,
        click: async () => {
          if (settingsSync === null) return
          try {
            const result = await settingsSync.publish()
            flashTrayTip(`已导出 ${result.count} 项设置`)
          } catch (error) {
            log('[sync] 导出失败：', error instanceof Error ? error.message : error)
            flashTrayTip('导出失败，详见日志')
          }
        }
      },
      {
        label: '应用对端变更',
        enabled: settingsSync !== null,
        click: async () => {
          if (settingsSync === null) return
          try {
            const result = await settingsSync.pull()
            flashTrayTip(
              result.applied > 0 ? `已应用 ${result.applied} 项设置` : '没有可应用的变更'
            )
          } catch (error) {
            log('[sync] 合并失败：', error instanceof Error ? error.message : error)
            flashTrayTip('合并失败，详见日志')
          }
        }
      },
      {
        label: '设置…',
        click: () => openSettingsWindow('general')
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          app.quit()
        }
      }
    ])

  tray.setContextMenu(trayMenuBuilder())

  tray.on('click', () => {
    if (win === null || win.isDestroyed()) return
    if (win.isVisible()) win.hide()
    else win.show()
  })
}

// clampBoundsToWorkArea / dockBoundsToBottomRight 已迁到 src/main/window-bounds.ts，
// workArea 由调用方从 screen 取好再注入。

/**
 * 找回窗口：挪回主屏右下角并显示。
 * 拔掉副屏、改分辨率之后窗口可能落在看不见的区域，托盘要有一个回城入口。
 */
function recoverWindow() {
  if (win === null || win.isDestroyed()) return
  const [width, height] = win.getSize()
  win.setBounds(dockBoundsToBottomRight({ width, height }))
  win.show()
  win.focus()
  void saveWindowState()
  flashTrayTip('已回到桌面右下角')
}

/**
 * 开机自启：真源是系统登录项，不另存一份设置，避免两处说法不一致。
 * 开发态 execPath 指向 electron.exe，写进去只会开机弹个空壳，所以只在打包后开放。
 */
function loginItemEnabled() {
  if (!app.isPackaged) return false
  try {
    return app.getLoginItemSettings().openAtLogin === true
  } catch (error) {
    log('[login-item] 读取失败：', error?.message ?? error)
    return false
  }
}

function setLoginItem(enabled) {
  if (!app.isPackaged) {
    flashTrayTip('打包后可用')
    return
  }
  try {
    app.setLoginItemSettings({ openAtLogin: enabled })
    // 写后读回，注册表被策略挡住时能立刻看出来，不留一个假勾选。
    const actual = app.getLoginItemSettings().openAtLogin === true
    if (actual !== enabled) {
      log('[login-item] 写入后读回不一致：', enabled, actual)
      flashTrayTip('开机自启没有生效，详见日志')
      return
    }
    flashTrayTip(enabled ? '下次登录会自动启动' : '已关闭开机自启')
  } catch (error) {
    log('[login-item] 写入失败：', error?.message ?? error)
    flashTrayTip('开机自启设置失败，详见日志')
  }
}

let saveStateTimer = null

/** 位置落盘；宽高仍写入留作诊断，启动恢复不采用。 */
async function saveWindowState() {
  if (win === null || win.isDestroyed()) return
  const bounds = win.getBounds()
  await writeJson(statePath, {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height
  })
}

/** 拖动 / 缩放会连续触发，攒 400ms 再写，避免频繁落盘。 */
function scheduleSaveWindowState() {
  if (saveStateTimer !== null) clearTimeout(saveStateTimer)
  saveStateTimer = setTimeout(() => {
    saveStateTimer = null
    void saveWindowState()
  }, 400)
}

/**
 * 渲染进程崩溃后的自愈。
 *
 * 之前这里只写一行日志：进程还在、托盘还在，窗口却停在最后一帧或者全透明，
 * 用户只能去任务管理器结束进程。现在按「10 分钟内最多 3 次」自动 reload，
 * 超过上限就明确告诉用户去托盘退出重开，不再假装没事。
 */
let reviveCount = 0
let reviveWindowStart = 0
let fallbackShown = false

function reviveRenderer(reason) {
  const now = Date.now()
  if (now - reviveWindowStart > 10 * 60_000) {
    reviveWindowStart = now
    reviveCount = 0
  }
  if (reviveCount >= 3) {
    log('[renderer] 连续崩溃，停止自动恢复：', reason)
    flashTrayTip('画面一直起不来，可以从托盘退出后重开')
    return
  }
  reviveCount += 1
  setTimeout(() => {
    if (win === null || win.isDestroyed()) return
    if (!win.isVisible()) win.show()
    win.webContents.reload()
    log('[renderer] 已尝试自动恢复，第', reviveCount, '次')
  }, 800)
}

/** 主页面都加载不出来时切到静态兜底页，至少让用户知道发生了什么。 */
function showFallbackPage(reason) {
  if (win === null || win.isDestroyed() || fallbackShown) return
  fallbackShown = true
  log('[renderer] 加载兜底页：', reason)
  void win
    .loadFile(path.join(__dirname, 'renderer', 'fallback.html'), { query: { reason } })
    .catch((error) => log('[renderer] 兜底页也失败：', error?.message ?? error))
}

async function createWindow() {
  const preloadPath = path.join(__dirname, 'preload.cjs')
  const options = createWindowOptions(settings, preloadPath)
  win = new BrowserWindow({
    ...options,
    icon: appIconPath,
    show: false,
    backgroundColor: '#00000000',
    title: '桌宠'
  })

  // 渲染层的报错只出现在页面里，主进程默认看不到。转发出来，
  // 否则「立绘没出来」只能靠猜。
  win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    log(`[renderer:${level}]`, message, `(${sourceId}:${line})`)
  })

  win.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    log('[renderer] did-fail-load', code, description, url)
    // -3 是 ERR_ABORTED：reload 打断上一次加载，不算真失败。
    if (isMainFrame !== true || code === -3) return
    showFallbackPage(description || `code ${code}`)
  })

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event) => event.preventDefault())
  win.webContents.on('render-process-gone', (_event, details) => {
    log('renderer 退出：', details.reason)
    if (details.reason === 'clean-exit') return
    reviveRenderer(details.reason)
  })
  win.webContents.on('did-finish-load', async () => {
    // 页面正常起来后允许下一次真失败重新走兜底页，不要把开关永久关上。
    fallbackShown = false
    // 密钥重建/隔离只提醒一次：reload 不该重复打扰。
    if (vaultStartupNotice !== null && !vaultNoticeDelivered) {
      vaultNoticeDelivered = true
      win.webContents.send('pet:vault:notice', vaultStartupNotice)
    }
    try {
      const status = await win.webContents.executeJavaScript(
        'document.getElementById("module-status")?.textContent ?? ""'
      )
      log('renderer 已加载，模块状态：', status)
      if (process.env.PET_SELFTEST === '1') {
        const result = await win.webContents.executeJavaScript('window.__petSelfTest?.() ?? null')
        log('四媒体自检：', JSON.stringify(result))
      }
    } catch (error) {
      log('renderer 状态检查失败：', error)
    }
  })

  // 桌宠窗口无边框、不聚焦，DOM 侧拿不到 blur / visibilitychange（实测 hidden 恒 false）。
  // 生命周期由主进程广播，渲染侧据此暂停 / 续播；每次广播都落日志，便于断言。
  const emitLifecycle = (state) => {
    if (win === null || win.isDestroyed()) return
    win.webContents.send('pet:lifecycle', state)
    log('lifecycle:', state)
  }
  win.on('blur', () => emitLifecycle('paused'))
  win.on('focus', () => emitLifecycle('resumed'))
  win.on('minimize', () => emitLifecycle('paused'))
  win.on('restore', () => emitLifecycle('resumed'))
  win.on('hide', () => emitLifecycle('paused'))
  win.on('show', () => emitLifecycle('resumed'))

  // 恢复上次位置；宽高不跟随 state，固定取当前 profile + scale 的结果。
  // 旧 state.json 里可能还留着历史宽高，但固定窗口不接受它们。
  const state = await readJson(statePath, {})
  if (typeof state.x === 'number' && typeof state.y === 'number') {
    const bounds = {
      x: state.x,
      y: state.y,
      width: options.width,
      height: options.height
    }
    win.setBounds(clampBoundsToWorkArea(bounds, screen.getDisplayMatching(bounds).workArea))
  }

  // 位置变化后自动记下；固定窗口不会再触发 resized，保留监听只作尺寸变更兜底。
  win.on('moved', scheduleSaveWindowState)
  win.on('resized', scheduleSaveWindowState)

  // ready-to-show 可能在 loadFile 期间就触发，必须先注册再加载，
  // 否则等 await 返回时事件已经错过，show() 永远不会被调用。
  win.once('ready-to-show', () => win.show())

  // 探针目标走 URL query：页面禁了 eval，executeJavaScript 在 CSP 下会直接失败，
  // 这条路径不依赖任何注入，纯读 location.search。
  const probe = process.env.PET_LIVE2D_PROBE ?? ''
  await win.loadFile(
    path.join(__dirname, 'renderer', 'index.html'),
    probe === '' ? {} : { query: { probe } }
  )

  // 兜底：极少数情况下 ready-to-show 不触发，显式补一次 show。
  if (!win.isVisible()) win.show()

  win.on('close', (event) => {
    if (win === null || win.isDestroyed()) return
    void saveWindowState()
    // 关闭窗口只是收起；真正退出走托盘菜单。
    // 窗口无边框且不进任务栏，直接关掉会让人找不到回来的路。
    if (app.isQuitting !== true) {
      event.preventDefault()
      win.hide()
    }
  })
}

app.whenReady().then(async () => {
  // 第二个实例只负责把第一只叫出来，自己不装配任何东西。
  if (!singleInstanceLock) return

  // 权限一律默认拒绝：桌宠不需要摄像头、麦克风、通知。
  // 只留剪贴板写入（诊断面板「复制报告」要用），其余请求落日志便于排查。
  const allowedPermissions = new Set(['clipboard-sanitized-write'])
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    const allowed = allowedPermissions.has(permission)
    if (!allowed) log('[permission] 已拒绝：', permission)
    callback(allowed)
  })
  session.defaultSession.setPermissionCheckHandler((_wc, permission) =>
    allowedPermissions.has(permission)
  )
  session.defaultSession.setDevicePermissionHandler(() => false)

  // 锁屏、休眠期间不主动搭话；唤醒后把计时起点推到现在，避免攒着一条立刻补发。
  powerMonitor.on('suspend', () => {
    systemAsleep = true
  })
  powerMonitor.on('lock-screen', () => {
    systemAsleep = true
  })
  const wakeUp = () => {
    systemAsleep = false
    lastSpokenAt = Date.now()
  }
  powerMonitor.on('resume', wakeUp)
  powerMonitor.on('unlock-screen', wakeUp)

  if (process.env.PET_VAULT_SMOKE === '1') {
    let code = 0
    try {
      const { runVaultSmoke } = await import('./vaultSmoke.mjs')
      await runVaultSmoke()
    } catch (error) {
      code = 1
      console.error('[vault-smoke] FAILED', error)
    }
    setTimeout(() => app.exit(code), 100)
    return
  }

  if (process.env.PET_VAULT_INIT_SMOKE === '1') {
    await initVault()
    if (vault !== null) {
      // 真机往返一次：确认 safeStorage 包裹的密钥确实能加解密。
      const probeClient = new VaultClient(new MemoryVaultStorage(), new AesGcmProvider(), vault.ring)
      const sealed = await probeClient.seal({ probe: 'vault-roundtrip' }, { kind: 'envelope' })
      const plain = await probeClient.open(sealed)
      console.log('[vault-roundtrip]', new TextDecoder().decode(plain))
    }
    const result = vault === null ? { ok: false } : await vault.diagnose()
    console.log('[vault-init]', JSON.stringify(result))
    setTimeout(() => app.exit(vault === null ? 1 : 0), 100)
    return
  }

  // 设置走 readSettings：主文件坏了先用 .bak，两份都坏就隔离留证，不静默清空。
  settings = mergeLayer(DEFAULT_SETTINGS, await readSettings())

  if (process.env.PET_BALANCE_SMOKE === '1') {
    let code = 0
    try {
      const { runBalanceSmoke } = await import('./balanceSmoke.mjs')
      const result = await runBalanceSmoke()
      console.log('[balance-smoke]', JSON.stringify(result))
      if (result.ok !== true) code = 1
    } catch (error) {
      code = 1
      console.error('[balance-smoke] FAILED', error)
    }
    setTimeout(() => app.exit(code), 100)
    return
  }

  await initSettingsSync()
  await initVault()
  // 通道依赖 Vault 里的凭据；初始化失败也要保住本地回环通道，不让桌宠失去响应路径。
  await createGateway().catch((error) =>
    log('[qq] 通道初始化失败：', error instanceof Error ? error.message : String(error))
  )
  registerMediaProtocol()
  await loadRpsStats()
  registerIpc()
  syncBalanceMonitor()
  await createWindow()
  createTray()
  // 指标采样只为状态条服务：关着就不启动，省掉每 6 秒一次 PowerShell。
  syncHudSampler()
  startDailyReviewTimer()
  // 主动开口的定时器一直挂着，开关在 setInterval 里判断，改设置即时生效。
  startPresenceTimer()
  if (settings.onboarded !== true) openOnboardingWindow()
  log('ready')
}).catch((error) => {
  // 启动链任一环抛错都不该留下「有进程没窗口」的幽灵：报出来，然后干净退出。
  log('[boot] 启动失败：', error)
  dialog.showErrorBox(
    '桌宠没能启动',
    `${error?.message ?? String(error)}\n\n数据目录：${userData}`
  )
  app.exit(1)
})

app.on('window-all-closed', () => {
  // 桌宠是常驻托盘应用：主窗口关闭只是 hide，窗口全销毁也不等于用户想退出。
  // 只有托盘没能建起来（比如图标缺失）时才跟着退出，避免变成关不掉的后台幽灵。
  if (tray === null) app.quit()
})

/** 退出前给记忆一次落盘机会；只用一次，避免 quit 递归。 */
let memoryFlushed = false

app.on('before-quit', (event) => {
  app.isQuitting = true
  if (gatewaySyncTimer !== null) {
    clearTimeout(gatewaySyncTimer)
    gatewaySyncTimer = null
  }
  gateway?.dispose()
  void qq?.stop?.().catch(() => undefined)
  qq = null
  webhookServer?.close()
  if (sessionIdleTimer !== null) {
    clearInterval(sessionIdleTimer)
    sessionIdleTimer = null
  }
  stopBalanceMonitor()
  if (memoryFlushed) return
  memoryFlushed = true
  event.preventDefault()
  // 落盘最多等 3 秒：加密仓库卡住时也得让用户关得掉，不能只留任务管理器。
  const flushed = Promise.allSettled([memoryStore.flush(), chatHistoryStore.flush()])
  const timeout = new Promise((resolve) => setTimeout(resolve, 3000))
  Promise.race([flushed, timeout]).finally(() => app.quit())
})

process.on('uncaughtException', (error) => {
  log('uncaughtException', error)
})

process.on('unhandledRejection', (reason) => {
  log('unhandledRejection', reason)
})
