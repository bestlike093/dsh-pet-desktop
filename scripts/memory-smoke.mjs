// 记忆层冒烟：摘要链、墓碑、预算装配、衰减与合并
import { MemoryStore, estimateTokens } from '../packages/memory/dist/index.js'

let failed = 0
function check(name, ok, extra = '') {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : ''))
  if (!ok) failed += 1
}

async function expectCode(fn, code) {
  try {
    await fn()
    return false
  } catch (error) {
    return error.code === code
  }
}

const signatures = []
const store = new MemoryStore({
  deviceId: 'device-A',
  signer: async (payload) => {
    signatures.push(payload)
    return `sig-${signatures.length}`
  },
  summarizer: async ({ turns, previous }) =>
    `summary(${turns.length})${previous === undefined ? '' : ` after ${previous}`}`
})

// 1. 写入与签名
const fact = await store.append({
  deviceId: 'device-A',
  layer: 'L2',
  kind: 'fact',
  text: '小鹿喜欢粉色',
  parentIds: [],
  sessionId: 's1',
  salience: 0.9,
  scope: 'shared'
})
check('append: 生成 HLC id', typeof fact.id === 'string' && fact.id.includes('-'))
check('append: hash 为 64 位 hex', /^[0-9a-f]{64}$/.test(fact.hash))
check('append: 调用签名端口', fact.sig === 'sig-1' && signatures.length === 1)
check('append: 签名覆盖 id 与 hash', signatures[0].startsWith(fact.id))

// 2. 摘要链
for (let index = 0; index < 8; index += 1) {
  store.addTurn('s1', { role: index % 2 === 0 ? 'user' : 'assistant', content: `第 ${index} 轮对话内容` })
}
const first = await store.summarize('s1', false)
check('summary: 达到轮数阈值触发', first !== null && first.kind === 'summary')
check('summary: 首节点无父', first.parentIds.length === 0)
check('summary: 压缩后清空 turns', store.turnsOf('s1').length === 0)

for (let index = 0; index < 8; index += 1) {
  store.addTurn('s1', { role: 'user', content: `第二批 ${index}` })
}
const second = await store.summarize('s1', false)
check('summary: 第二节点挂到链上', second !== null && second.parentIds[0] === first.id)
check('summary: 摘要文本带前序', second.text.includes('after'))

const quiet = new MemoryStore({
  deviceId: 'device-B',
  summarizer: async () => 'should not run'
})
quiet.addTurn('s2', { role: 'user', content: '只说一句' })
check('summary: 未到阈值不压缩', (await quiet.summarize('s2', false)) === null)

const failing = new MemoryStore({
  deviceId: 'device-C',
  summarizer: async () => {
    throw new Error('network down')
  }
})
for (let index = 0; index < 8; index += 1) {
  failing.addTurn('s3', { role: 'user', content: `待压缩 ${index}` })
}
check('summary: 失败返回 null', (await failing.summarize('s3', false)) === null)
check('summary: 失败保留原 turns', failing.turnsOf('s3').length === 8)

const emptySummary = new MemoryStore({ deviceId: 'device-D', summarizer: async () => '   ' })
for (let index = 0; index < 8; index += 1) emptySummary.addTurn('s4', { role: 'user', content: 'x' })
check('summary: 空摘要不落库', (await emptySummary.summarize('s4', false)) === null)

// 3. 墓碑
const doomed = await store.append({
  deviceId: 'device-A',
  layer: 'L2',
  kind: 'fact',
  text: '这条会被删除',
  parentIds: [],
  sessionId: 's1',
  salience: 1,
  scope: 'shared'
})
const stone = await store.tombstone(doomed.id)
check('tombstone: 生成墓碑记录', stone.kind === 'tombstone' && stone.parentIds[0] === doomed.id)
check('tombstone: 目标不存在时报 MEMORY_NOT_FOUND', await expectCode(() => store.tombstone('missing'), 'MEMORY_NOT_FOUND'))

const bundle = await store.assemble('s1', {
  persona: '示例人格提示词',
  currentEvent: '用户在问框架进度'
})
check('assemble: 事实被装配', bundle.facts.includes('小鹿喜欢粉色'))
check('assemble: 墓碑目标被排除', !bundle.facts.includes('这条会被删除'))
check('assemble: 摘要链进入上下文', bundle.summaries.length === 2)
check('assemble: 最近轮次为空', bundle.recentTurns.length === 0)
check('assemble: digest 为 64 位 hex', /^[0-9a-f]{64}$/.test(bundle.digest))
check('assemble: 预算估算为正数', bundle.tokenEstimate > 0)
check('assemble: 人格段保留', bundle.persona.includes('示例'))

// 4. 预算裁剪
const tight = await store.assemble('s1', { budget: { facts: 1, summary: 1, persona: 0, event: 0 } })
check('budget: 事实段按预算截断', tight.facts.length === 0)
check('budget: 摘要段按预算截断', tight.summaries.length === 0)

const recentStore = new MemoryStore({ deviceId: 'device-E' })
for (let index = 0; index < 6; index += 1) {
  recentStore.addTurn('s5', { role: 'user', content: `第 ${index} 条比较长的对话内容` })
}
const recentBundle = await recentStore.assemble('s5', { budget: { recent: 20 } })
check('budget: 最近轮次保留最新', recentBundle.recentTurns.at(-1).content.includes('第 5 条'))
check('budget: 最近轮次丢弃最旧', recentBundle.recentTurns.every((turn) => !turn.content.includes('第 0 条')))
check('budget: token 估算可用', estimateTokens('一二三') === 3)

// 5. 衰减
const faded = await store.decay(Date.now() + 90 * 24 * 60 * 60_000)
check('decay: 低显著度条目被计数', faded > 0)

// 6. 合并与同步范围
const peer = new MemoryStore({ deviceId: 'device-F' })
const shared = await peer.append({
  deviceId: 'device-F',
  layer: 'L2',
  kind: 'preference',
  text: '小鹿偏好简体中文',
  parentIds: [],
  sessionId: 's6',
  salience: 0.8,
  scope: 'shared'
})
const localOnly = await peer.append({
  deviceId: 'device-F',
  layer: 'L2',
  kind: 'event',
  text: '本机临时事件',
  parentIds: [],
  sessionId: 's6',
  salience: 0.8,
  scope: 'local'
})

check('sync: 只导出 shared', peer.syncable().every((record) => record.scope === 'shared'))
const merged = store.merge(peer.syncable())
check('sync: 合并新增记录', merged.added === 1 && store.snapshot().some((record) => record.id === shared.id))
check('sync: local 记录不外流', !store.snapshot().some((record) => record.id === localOnly.id))
check('sync: 重复合并幂等', store.merge(peer.syncable()).added === 0)

const replica = new MemoryStore({ deviceId: 'device-G' })
replica.merge(store.syncable())
check('sync: 副本链根一致', (await replica.chainRoot()) === (await store.chainRoot()))
check('sync: 链根为 64 位 hex', /^[0-9a-f]{64}$/.test(await store.chainRoot()))

console.log('\nMEMORY_SMOKE_' + (failed === 0 ? 'OK' : 'FAILED_' + failed))
process.exit(failed === 0 ? 0 : 1)
