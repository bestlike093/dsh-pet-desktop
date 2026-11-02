// 语音链路自测：地址补全、本地探测、该不该念。
// 不拉起 Electron，只验证纯逻辑与一次真实 HTTP 探测。
import http from 'node:http'
import { DEFAULT_SETTINGS } from '../packages/shared/dist/index.js'
import { planSpeak, probeTtsEndpoint, toTtsEndpoint } from '../apps/desktop/electron/voice-service.mjs'

let failed = 0
function check(name, ok, extra = '') {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : ''))
  if (!ok) failed += 1
}

// ---- 地址补全 ----
check('endpoint: 端口补 /tts', toTtsEndpoint('http://127.0.0.1:9880') === 'http://127.0.0.1:9880/tts')
check('endpoint: 已有 /tts 不重复', toTtsEndpoint('http://127.0.0.1:9880/tts') === 'http://127.0.0.1:9880/tts')
check('endpoint: 末尾斜杠先去掉', toTtsEndpoint('http://127.0.0.1:9880///') === 'http://127.0.0.1:9880/tts')
check('endpoint: 空地址保持空', toTtsEndpoint('   ') === '')

// ---- 本地探测 ----
const server = http.createServer((_request, response) => {
  // GPT-SoVITS 的 /tts 只收 POST，GET 回 405 是正常应答。
  response.statusCode = 405
  response.end('method not allowed')
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const online = await probeTtsEndpoint(`http://127.0.0.1:${port}/tts`, 800)
check('probe: 405 也算在线', online.ok === true && online.status === 405, JSON.stringify(online))
server.close()

const offline = await probeTtsEndpoint('http://127.0.0.1:1/tts', 500)
check('probe: 没人听时不在线', offline.ok === false, JSON.stringify(offline))

const remote = await probeTtsEndpoint('http://example.com/tts', 500)
check('probe: 非回环直接拒绝', remote.ok === false && remote.error === 'not-loopback', JSON.stringify(remote))

// ---- 该不该念 ----
const noon = Date.parse('2026-11-01T12:00:00+08:00')
const base = {
  ...DEFAULT_SETTINGS.voice,
  enabled: true,
  quietHours: { enabled: false, start: '22:00', end: '08:00' },
  refAudioPath: 'D:/voices/cyrene.wav',
  localUrl: 'http://127.0.0.1:9880'
}

check('plan: 总开关关掉不出声', planSpeak({ voice: { ...base, enabled: false }, text: '你好', now: noon }).reason === 'silent')
check(
  'plan: 只在小喇叭被点时，自动不念',
  planSpeak({ voice: { ...base, trigger: 'manual' }, text: '你好', reason: 'auto', now: noon }).reason === 'silent'
)
check(
  'plan: 只在小喇叭被点时，手动照念',
  planSpeak({ voice: { ...base, trigger: 'manual' }, text: '你好', reason: 'manual', now: noon }).ok === true
)
check(
  'plan: 云端未配置不合成',
  planSpeak({ voice: { ...base, provider: 'cloud' }, text: '你好', now: noon }).reason === 'cloud-not-ready'
)
check(
  'plan: 参考音频空着不合成',
  planSpeak({ voice: { ...base, refAudioPath: '' }, text: '你好', now: noon }).reason === 'no-ref-audio'
)
check(
  'plan: 空地址不合成',
  planSpeak({ voice: { ...base, localUrl: '' }, text: '你好', now: noon }).reason === 'no-endpoint'
)
check('plan: 空文本不出声', planSpeak({ voice: base, text: '  ', now: noon }).reason === 'empty')

const throttled = planSpeak({
  voice: { ...base, minIntervalSeconds: 10 },
  text: '你好',
  reason: 'auto',
  now: noon,
  lastAutoSpeakAt: noon - 1000
})
check('plan: 自动念按最小间隔节流', throttled.reason === 'rate-limited')

const manualDuringGap = planSpeak({
  voice: { ...base, minIntervalSeconds: 10 },
  text: '你好',
  reason: 'manual',
  now: noon,
  lastAutoSpeakAt: noon - 1000
})
check('plan: 点小喇叭不受节流限制', manualDuringGap.ok === true && manualDuringGap.autoSpeakAt === null)

const longText = '字'.repeat(100)
const truncated = planSpeak({ voice: { ...base, maxChars: 8 }, text: longText, now: noon })
check('plan: 超出 maxChars 只念前一段', truncated.ok === true && truncated.text === '字'.repeat(8))
check('plan: 自动念推进节流时间', truncated.autoSpeakAt === noon)

const emoji = planSpeak({ voice: { ...base, maxChars: 2 }, text: '🎉🎊🎁', now: noon })
check('plan: 按码点截断不撕裂表情', emoji.text === '🎉🎊')

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exitCode = failed === 0 ? 0 : 1
