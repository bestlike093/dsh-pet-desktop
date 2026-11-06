/**
 * 配置 schema v2.1 契约（文档第 13 章）。
 * 与现有扁平 SettingsV2 并存：v2.1 是目标形状，迁移函数负责过渡。
 */

import type { CryptoSuiteId } from './crypto.js'
import type { TokenBudget } from './memory.js'
import type { EmotionTag, ProfileName } from '../types/model.js'
import type { Permission, RenderMode } from '../types/module.js'
import { ALL_PERMISSIONS } from '../types/module.js'
import { EMOTION_TAGS } from '../types/model.js'
import type { SettingsV2 } from '../types/settings.js'

export interface UiSettingsV21 {
  readonly profile: ProfileName
  readonly theme: string
  readonly scale: number
  readonly fpsCap: number
}

export interface ModuleSettingsV21 {
  readonly enabled: boolean
  readonly renderMode: RenderMode
  readonly permissions?: readonly Permission[]
  readonly config?: Readonly<Record<string, unknown>>
  readonly timeoutMs?: number
  readonly timeoutPolicy?: 'fallback-local' | 'block'
}

export interface EmotionSettingsV21 {
  readonly vocab: readonly EmotionTag[]
  readonly similarityThreshold: number
  readonly pairOnly: boolean
}

export interface ChannelCredentialsV21 {
  readonly enabled: boolean
  /** 形如 vault:qq-token；settings.json 里永远不出现凭据值 */
  readonly credentialRef?: string
}

export interface QqChannelSettings extends ChannelCredentialsV21 {
  readonly appId: string
}

export interface WechatChannelSettings extends ChannelCredentialsV21 {
  readonly mode: 'ilink'
}

export interface WebhookChannelSettings extends ChannelCredentialsV21 {
  readonly url: string
}

export interface ChannelsSettingsV21 {
  readonly qq: QqChannelSettings
  readonly wechat: WechatChannelSettings
  readonly webhook: WebhookChannelSettings
}

export interface VaultKdfSettingsV21 {
  readonly algo: 'argon2id'
  readonly m: number
  readonly t: number
  readonly p: number
}

export interface VaultSettingsV21 {
  readonly backend: 'system-keychain' | 'passphrase' | 'plaintext-dir'
  readonly suite: CryptoSuiteId
  readonly pqEnabled: boolean
  readonly kdf: VaultKdfSettingsV21
  readonly rotationDays: number
  readonly decryptWindowDays: number
  readonly auditChain: boolean
  readonly redactTelemetry: boolean
  readonly isolatedProcess: boolean
}

export interface InteropSettingsV21 {
  readonly enabled: boolean
  readonly probeIntervalMin: number
  readonly maxClockDriftMs: number
  readonly consistencyPolicy: 'warn' | 'block'
  readonly trustedPeersPath: string
  readonly lanFallback: boolean
}

export interface MemorySettingsV21 {
  readonly syncEnabled: boolean
  readonly summaryEveryTurns: number
  readonly summaryMaxAgeMin: number
  readonly tokenBudget: TokenBudget
  readonly salienceHalfLifeDays: number
  readonly salienceFloor: number
  readonly tombstoneInsteadOfDelete: boolean
}

export interface SettingsV21 {
  readonly schemaVersion: 2
  readonly ui: UiSettingsV21
  readonly modules: Readonly<Record<string, ModuleSettingsV21>>
  readonly emotion: EmotionSettingsV21
  readonly channels: ChannelsSettingsV21
  readonly vault: VaultSettingsV21
  readonly interop: InteropSettingsV21
  readonly memory: MemorySettingsV21
  /** 迁移时未识别的旧字段，留作回滚，不在设置页展示 */
  readonly _legacy?: Readonly<Record<string, unknown>>
}

const DEFAULT_MODULES: Readonly<Record<string, ModuleSettingsV21>> = {
  'task-progress': { enabled: true, renderMode: 'embedded', permissions: ['ui.render'] },
  question: { enabled: true, renderMode: 'fixed:card' },
  approval: { enabled: true, renderMode: 'standalone' },
  'status-panel': { enabled: true, renderMode: 'embedded' },
  dialogue: { enabled: true, renderMode: 'embedded' },
  'remote-gateway': {
    enabled: true,
    renderMode: 'headless',
    timeoutMs: 300_000,
    timeoutPolicy: 'fallback-local'
  }
}

export const DEFAULT_SETTINGS_V21: SettingsV21 = {
  schemaVersion: 2,
  ui: { profile: 'vertical', theme: 'Paper', scale: 1, fpsCap: 30 },
  modules: DEFAULT_MODULES,
  emotion: { vocab: EMOTION_TAGS, similarityThreshold: 0.6, pairOnly: true },
  channels: {
    qq: { enabled: false, appId: '', credentialRef: 'vault:qq-token' },
    wechat: { enabled: false, mode: 'ilink', credentialRef: 'vault:wx-token' },
    webhook: { enabled: false, url: '', credentialRef: 'vault:wh-secret' }
  },
  vault: {
    backend: 'system-keychain',
    suite: 'CS1',
    pqEnabled: false,
    kdf: { algo: 'argon2id', m: 65_536, t: 3, p: 1 },
    rotationDays: 90,
    decryptWindowDays: 30,
    auditChain: true,
    redactTelemetry: true,
    isolatedProcess: true
  },
  interop: {
    enabled: true,
    probeIntervalMin: 30,
    maxClockDriftMs: 60_000,
    consistencyPolicy: 'warn',
    trustedPeersPath: 'trusted-peers.json',
    lanFallback: false
  },
  memory: {
    syncEnabled: true,
    summaryEveryTurns: 8,
    summaryMaxAgeMin: 30,
    tokenBudget: { persona: 300, facts: 400, summary: 600, recent: 800, event: 300 },
    salienceHalfLifeDays: 14,
    salienceFloor: 0.1,
    tombstoneInsteadOfDelete: true
  }
}

const KNOWN_V2_KEYS: ReadonlySet<string> = new Set([
  'schemaVersion',
  'nickname',
  'onboarded',
  'uiMode',
  'renderMode',
  'profile',
  'window',
  'bubble',
  'icon',
  'sticker',
  'askHandling',
  'askEveryMinutes',
  'poseEverySeconds',
  'soundLevel',
  'voice',
  'showHud',
  'hudName',
  'hudDetail',
  'hudAlpha',
  'hudScale',
  'hudFontScale',
  'theme',
  'modules',
  'locale',
  'companion',
  'presence',
  'balance',
  'channels',
  'defaultEmotion',
  'live2dModelId',
  'wakeWords'
])

function isPermission(value: string): value is Permission {
  return (ALL_PERMISSIONS as readonly string[]).includes(value)
}

/**
 * v1/v2 扁平配置 → v2.1 嵌套配置。
 * 未知字段进 _legacy；card profile 强制 scale=1（文档 13.1）。
 */
export function settingsV2ToV21(legacy: SettingsV2): SettingsV21 {
  const raw = legacy as unknown as Record<string, unknown>
  const extras: Record<string, unknown> = {}
  for (const key of Object.keys(raw)) {
    if (!KNOWN_V2_KEYS.has(key)) extras[key] = raw[key]
  }

  const modules: Record<string, ModuleSettingsV21> = { ...DEFAULT_MODULES }
  for (const [id, toggle] of Object.entries(legacy.modules)) {
    const permissions = toggle.permissions.filter(isPermission)
    modules[id] = {
      enabled: toggle.enabled,
      renderMode: legacy.renderMode,
      ...(permissions.length === 0 ? {} : { permissions })
    }
  }

  const profile = legacy.profile
  const migrated: SettingsV21 = {
    ...DEFAULT_SETTINGS_V21,
    ui: {
      profile,
      theme: legacy.theme.preset,
      scale: profile === 'card' ? 1 : legacy.window.scale,
      fpsCap: 30
    },
    modules
  }

  return Object.keys(extras).length === 0 ? migrated : { ...migrated, _legacy: extras }
}
