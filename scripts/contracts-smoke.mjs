// 契约冒烟：验证 v2.1 契约常量、默认配置与 v2 → v2.1 迁移
import {
  CHANNEL_IDS,
  CONSISTENCY_LEVELS,
  CRYPTO_SUITE_ORDER,
  DECISION_ACTIONS,
  DECISION_KINDS,
  DEFAULT_SETTINGS,
  DEFAULT_SETTINGS_V21,
  DEFAULT_TOKEN_BUDGET,
  EMOTION_RESOLUTION_SOURCES,
  MEMORY_KINDS,
  SUITES,
  isDialoguePair,
  negotiateSuite,
  settingsV2ToV21
} from '../packages/shared/dist/index.js'

let failed = 0
function check(name, ok, extra = '') {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : ''))
  if (!ok) failed += 1
}

// 1. 密码套件
check('crypto: 三套件齐全', Object.keys(SUITES).sort().join(',') === 'CS1,CS2,CS3')
check('crypto: CS1 为 AES-256-GCM', SUITES.CS1.aead === 'AES-256-GCM')
check('crypto: CS2 为 XChaCha20', SUITES.CS2.aead === 'XChaCha20-Poly1305' && SUITES.CS2.hash === 'BLAKE3')
check('crypto: CS3 为混合 KEM', SUITES.CS3.kem === 'MLKEM768-X25519')
check('crypto: 协商优先级高在前', CRYPTO_SUITE_ORDER[0] === 'CS3' && CRYPTO_SUITE_ORDER[2] === 'CS1')
check('crypto: 交集取最高优先级', negotiateSuite(['CS1', 'CS2'], ['CS2', 'CS3']) === 'CS2')
check('crypto: 无交集返回 null', negotiateSuite(['CS1'], ['CS2']) === null)

// 2. 一致性与决策
check('interop: 一致性等级三档', CONSISTENCY_LEVELS.join(',') === 'consistent,converging,divergent')
check('channel: 决策类型三种', DECISION_KINDS.length === 3 && DECISION_KINDS.includes('approval'))
check('channel: 决策动作四种', DECISION_ACTIONS.includes('allow') && DECISION_ACTIONS.includes('dismiss'))
check('channel: 本地回环通道存在', CHANNEL_IDS.includes('local-loopback'))

// 3. 情绪
check('emotion: 降级来源六级', EMOTION_RESOLUTION_SOURCES.length === 6)
check(
  'emotion: 成对判定接受合法输入',
  isDialoguePair({ emotion: 'happy', line: '今天也要开心呀♪' })
)
check('emotion: 成对判定拒绝空台词', !isDialoguePair({ emotion: 'happy', line: '' }))
check('emotion: 成对判定拒绝非对象', !isDialoguePair('happy'))

// 4. 记忆契约
check(
  'memory: 记录类型六种',
  MEMORY_KINDS.length === 6 && MEMORY_KINDS.includes('tombstone') && MEMORY_KINDS.includes('revision')
)
check(
  'memory: 默认预算合计 2400',
  DEFAULT_TOKEN_BUDGET.persona +
    DEFAULT_TOKEN_BUDGET.facts +
    DEFAULT_TOKEN_BUDGET.summary +
    DEFAULT_TOKEN_BUDGET.recent +
    DEFAULT_TOKEN_BUDGET.event ===
    2400
)

// 5. v2.1 配置默认值
const v21 = DEFAULT_SETTINGS_V21
check('settings: schemaVersion 为 2', v21.schemaVersion === 2)
check('settings: 帧率上限 30', v21.ui.fpsCap === 30)
check('settings: Vault 默认 CS1', v21.vault.suite === 'CS1' && v21.vault.kdf.algo === 'argon2id')
check('settings: 互联探针 30 分钟', v21.interop.probeIntervalMin === 30)
check('settings: 记忆预算与文档一致', v21.memory.tokenBudget.recent === 800 && v21.memory.salienceHalfLifeDays === 14)
check(
  'settings: 六个内置模块',
  Object.keys(v21.modules).length === 6 && v21.modules['remote-gateway'].timeoutPolicy === 'fallback-local'
)
check(
  'settings: 凭据只存引用',
  v21.channels.qq.credentialRef === 'vault:qq-token' && v21.channels.wechat.mode === 'ilink'
)

// 6. v2 → v2.1 迁移
const cardLegacy = {
  ...DEFAULT_SETTINGS,
  profile: 'card',
  window: { ...DEFAULT_SETTINGS.window, scale: 0.8 },
  modules: {
    'task-progress': { enabled: false, permissions: ['ui.render', 'not.a.permission'] },
    'my-module': { enabled: true, permissions: [] }
  },
  mystery: 'keep-me'
}
const card = settingsV2ToV21(cardLegacy)
check('migrate: card 强制 scale=1', card.ui.scale === 1)
check('migrate: 主题沿用旧 preset', card.ui.theme === DEFAULT_SETTINGS.theme.preset)
check('migrate: 模块开关保留', card.modules['task-progress'].enabled === false)
check(
  'migrate: 非法权限被过滤',
  card.modules['task-progress'].permissions.length === 1 &&
    card.modules['task-progress'].permissions[0] === 'ui.render'
)
check('migrate: 自定义模块保留', card.modules['my-module']?.enabled === true)
check('migrate: 内置模块未被覆盖丢失', card.modules['question'] !== undefined)
check('migrate: 未知字段进 _legacy', card._legacy?.mystery === 'keep-me')

const vertical = settingsV2ToV21({
  ...DEFAULT_SETTINGS,
  profile: 'vertical',
  window: { ...DEFAULT_SETTINGS.window, scale: 0.65 }
})
check('migrate: 非 card 保留 scale', vertical.ui.scale === 0.65)
check('migrate: 无未知字段时不带 _legacy', vertical._legacy === undefined)

console.log('\nCONTRACTS_SMOKE_' + (failed === 0 ? 'OK' : 'FAILED_' + failed))
process.exit(failed === 0 ? 0 : 1)
