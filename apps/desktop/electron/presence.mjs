/**
 * 桌宠主动说话的情境层。
 *
 * 台词原来由渲染层一个静态数组轮播，跟此刻在发生什么没有关系。
 * 这里把「此刻」整理成可用的事实，再交给模型写成一句话：
 *
 *   时间  —— 几点、星期几、是不是深夜
 *   天气  —— open-meteo 免密钥接口，按设置里的城市取，30 分钟缓存
 *   陪伴  —— 这次开机陪了多久、上次被点是什么时候
 *   心情  —— 由时间与陪伴推导的轻量状态，不是独立的心情系统
 *   记忆  —— 注入 getMemoryDigest()，只取摘要，不读原始记录
 *
 * 任何一环失败都不抛错：天气拿不到就少写天气，模型调不通就退回本地短句。
 * 台词只有一句，宁可朴素，也不能让气泡空着或者报错。
 */

const CHAT_ENDPOINT = 'https://api.deepseek.com/chat/completions'
const WEATHER_ENDPOINT = 'https://api.open-meteo.com/v1/forecast'

/** 说的这一句最长多少字。气泡窄，超过就要换行了。 */
export const MAX_LINE_CHARS = 40

/** 天气缓存多久。15 分钟对一个桌面宠物来说足够新，也省得频繁打外部接口。 */
const WEATHER_TTL_MS = 15 * 60 * 1000

/**
 * 常见城市坐标。设置里填了别的名字也不报错，回落到重庆，
 * 并在返回体里标 requested，方便设置页如实显示用的是哪座城。
 */
const CITY_COORDS = {
  重庆: { latitude: 29.5636, longitude: 106.5516 },
  北京: { latitude: 39.9042, longitude: 116.4074 },
  上海: { latitude: 31.2304, longitude: 121.4737 },
  广州: { latitude: 23.1291, longitude: 113.2644 },
  深圳: { latitude: 22.5431, longitude: 114.0579 },
  成都: { latitude: 30.5728, longitude: 104.0668 },
  杭州: { latitude: 30.2741, longitude: 120.1551 },
  武汉: { latitude: 30.5928, longitude: 114.3055 },
  西安: { latitude: 34.3416, longitude: 108.9398 },
  南京: { latitude: 32.0603, longitude: 118.7969 },
  天津: { latitude: 39.3434, longitude: 117.3616 },
  苏州: { latitude: 31.2989, longitude: 120.5853 }
}

const DEFAULT_CITY = '重庆'

/** WMO 天气代码 → 说话能用的中文。用不到的组合一律给「天气不明」。 */
const WEATHER_TEXT = {
  0: '晴',
  1: '大致晴',
  2: '多云',
  3: '阴',
  45: '有雾',
  48: '有雾',
  51: '毛毛雨',
  53: '毛毛雨',
  55: '毛毛雨',
  56: '冻雨',
  57: '冻雨',
  61: '小雨',
  63: '中雨',
  65: '大雨',
  66: '冻雨',
  67: '冻雨',
  71: '小雪',
  73: '中雪',
  75: '大雪',
  77: '米雪',
  80: '阵雨',
  81: '阵雨',
  82: '强阵雨',
  85: '阵雪',
  86: '阵雪',
  95: '雷阵雨',
  96: '雷暴',
  99: '雷暴'
}

/**
 * 把时间翻成「人怎么感知此刻」。
 * 只做本机时区计算，不推断所在地。
 */
export function timeContext(now = new Date()) {
  const hour = now.getHours()
  const weekday = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][now.getDay()]
  const period =
    hour < 5 ? '深夜' : hour < 9 ? '清晨' : hour < 12 ? '上午' : hour < 14 ? '中午' : hour < 18 ? '下午' : hour < 23 ? '晚上' : '深夜'
  const hourLabel =
    hour < 5 ? '凌晨' : hour < 6 ? '天快亮' : hour < 9 ? '早上' : hour < 12 ? '上午' : hour < 14 ? '午后' : hour < 18 ? '下午' : hour < 22 ? '晚上' : '深夜'
  return {
    hour,
    weekday,
    period,
    hourLabel,
    dateLabel: `${now.getMonth() + 1}月${now.getDate()}日`,
    clock: `${String(hour).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
  }
}

/**
 * 轻量心情推断。
 *
 * 这不是一个完整的心情系统，只是把「此刻更可能是什么状态」算出来，
 * 让台词有依据。每条规则都能用一句话解释，不做黑箱打分。
 */
export function moodSnapshot(options) {
  const { now = new Date(), sessionStartedAt = null, lastContactAt = null, balanceLow = false } = options ?? {}
  const hour = now.getHours()
  const reasons = []

  let level = 'calm'
  let label = '安静陪着'

  if (sessionStartedAt !== null && now.getTime() - sessionStartedAt >= 3 * 60 * 60 * 1000) {
    level = 'clingy'
    label = '陪得有点久了'
    reasons.push('连续陪伴超过 3 小时')
  }
  if (lastContactAt !== null && now.getTime() - lastContactAt <= 10 * 60 * 1000) {
    level = 'bright'
    label = '刚被注意到'
    reasons.push('10 分钟内被点过')
  }
  if (balanceLow) {
    reasons.push('余额偏低')
  }
  if (hour >= 23 || hour < 5) {
    level = 'sleepy'
    label = '有点担心你还没睡'
    reasons.push('现在是深夜')
  }

  return { level, label, reasons }
}

/** 天气代码转中文；认识的给具体天气，不认识的说「天气不明」，不猜。 */
export function weatherCodeToText(code) {
  return WEATHER_TEXT[code] ?? '天气不明'
}

/**
 * 取当前天气。失败返回 { ok: false, reason }，调用方据此少写一句天气，
 * 不重试、不缓存失败结果。
 */
export async function fetchWeather(options) {
  const { city = DEFAULT_CITY, fetchImpl = globalThis.fetch, timeoutMs = 4000 } = options ?? {}
  const name = String(city ?? '').trim() || DEFAULT_CITY
  const coords = CITY_COORDS[name] ?? CITY_COORDS[DEFAULT_CITY]
  const resolved = CITY_COORDS[name] === undefined ? DEFAULT_CITY : name

  const url =
    `${WEATHER_ENDPOINT}?latitude=${coords.latitude}&longitude=${coords.longitude}` +
    '&current=temperature_2m,weather_code&timezone=Asia%2FShanghai'

  const controller = typeof AbortController === 'function' ? new AbortController() : null
  const timer = controller === null ? null : setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(url, controller === null ? {} : { signal: controller.signal })
    if (!response.ok) return { ok: false, reason: `http-${response.status}` }
    const body = await response.json()
    const current = body?.current ?? {}
    const temp = Number(current.temperature_2m)
    const code = Number(current.weather_code)
    if (!Number.isFinite(temp)) return { ok: false, reason: 'bad-payload' }
    return {
      ok: true,
      city: resolved,
      requested: name,
      temperature: Math.round(temp),
      text: weatherCodeToText(code),
      code: Number.isFinite(code) ? code : null
    }
  } catch (error) {
    return { ok: false, reason: error?.name === 'AbortError' ? 'timeout' : 'network' }
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

/**
 * 拼给模型的指令。
 *
 * 约束写得硬一点：模型很容易写成客服腔或者解释自己，
 * 这里明确「一句话、不用引号、不解释、不列举」。
 */
export function buildBubblePrompt(context) {
  const { nickname = '', personaText = '', timeCtx, weather = null, mood = null, memoryDigest = '', recentLines = [], motions = null } = context ?? {}
  const who = nickname.trim() === '' ? '对方' : nickname.trim()

  const facts = [
    `现在是${timeCtx.dateLabel} ${timeCtx.weekday} ${timeCtx.clock}，${timeCtx.hourLabel}。`
  ]
  if (weather !== null && weather.ok === true) {
    facts.push(`外面${weather.city}${weather.text}，${weather.temperature}℃。`)
  }
  if (mood !== null) {
    facts.push(`你此刻的状态：${mood.label}。`)
  }
  if (memoryDigest.trim() !== '') {
    facts.push(`你记得的事：${memoryDigest.trim()}`)
  }
  if (recentLines.length > 0) {
    facts.push(`最近说过的话，别重复：${recentLines.join(' / ')}`)
  }
  // 动作清单来自渲染层真实探测：探测不到能力就不给清单，模型也就无从瞎点。
  const motionList = describeMotions(motions)
  if (motionList !== '') {
    facts.push(`你此刻能做的动作：${motionList}。`)
  }

  const system = [
    typeof personaText === 'string' && personaText.trim() !== ''
      ? personaText.trim()
      : '你是一个安静、温柔的桌面伙伴。',
    '',
    '现在你要主动说一句很短的话，像坐在旁边随口说的，不是回答问题。',
    `要求：只输出一句话，不超过 ${MAX_LINE_CHARS} 个字；不要引号、不要括号、不要 emoji；`,
    '不要解释你在做什么，不要列点，不要问候模板，不要提到「根据时间」「根据天气」这类分析口吻。',
    '如果没什么可说的，就写一句安静的陪伴感，不要硬凑信息。',
    ...(motionList === ''
      ? []
      : [
          '',
          '你可以在句子最后单独加一个动作标记来控制自己的身体，格式必须是 [动作:名称]，',
          '名称只能从上面「你此刻能做的动作」里挑一个；这句话配不上动作就什么标记都不要加。',
          '标记不算进字数，也不要写在引号里，不要解释它。'
        ])
  ].join('\n')

  const user = [`对方叫${who}。`, ...facts].join('\n')
  return { system, user }
}

/**
 * 把渲染层探测到的动作能力写成一句人话。
 * 只列真的能播的（actions 是渲染层按通道筛过的），标签用中文，模型更好挑。
 */
export function describeMotions(motions) {
  if (motions === null || typeof motions !== 'object') return ''
  const actions = Array.isArray(motions.actions) ? motions.actions : []
  if (actions.length === 0) return ''
  const labels = motions.labels ?? {}
  return actions
    .map((key) => (typeof labels[key] === 'string' && labels[key] !== '' ? `${labels[key]}(${key})` : String(key)))
    .join('、')
}

/** 动作标记：带捕获组，用于取出动作名。 */
const MOTION_TAG_PATTERN = /[[【(（]\s*动作\s*[:：]\s*([^\]】)）\n]{1,24})\s*[\]】)）]/
/** 同上但不捕获、全局，用于清洗时把标记整段抹掉。 */
const MOTION_TAG_GLOBAL = /[[【(（]\s*动作\s*[:：]\s*[^\]】)）\n]{1,24}\s*[\]】)）]/g

/**
 * 从模型输出里摘出动作标记。
 *
 * 要在 cleanBubbleLine 之前调用：清洗会只保留第一个句号前的内容，
 * 句末的标记会被一起砍掉。cleanBubbleLine 里也留了一道剥标记的兜底，
 * 万一顺序被人改动，气泡里也不会漏出 `sleepyNod]` 这种残骸。
 * 认 `[动作:x]`、`【动作：x】`、`(动作: x)` 三种写法，只取第一个，其余原样留着。
 *
 * @returns {{text:string, motion:string|null}}
 */
export function parseMotionTag(raw) {
  if (typeof raw !== 'string') return { text: '', motion: null }
  const hit = raw.match(MOTION_TAG_PATTERN)
  if (hit === null) return { text: raw, motion: null }
  const motion = hit[1].trim()
  return {
    text: raw.replace(hit[0], '').trim(),
    motion: motion === '' ? null : motion
  }
}

/**
 * 清洗模型输出。
 *
 * 模型常见的越界：包引号、加「昔涟：」、换行写解释、一句话写成两句、
 * 混进动作标记。这里只保留第一句有效内容，超长直接截断，
 * 空内容返回 null 让调用方回落。
 */
export function cleanBubbleLine(raw) {
  if (typeof raw !== 'string') return null
  let text = raw.trim()
  if (text === '') return null

  // 先抹掉动作标记，否则「只取第一句」会把标记切成半截留在气泡里。
  text = text.replace(MOTION_TAG_GLOBAL, '').trim()
  if (text === '') return null
  // 去掉整段包裹的引号 / 括号。
  text = text.replace(/^["'“”‘’「『（(]+/, '').replace(/["'“”‘’」』）)]+$/, '')
  // 去掉「昔涟：」「她：」这类说话人前缀。
  text = text.replace(/^[^：:\n]{1,8}[：:]\s*/, '')
  // 只取第一行，再取第一个句号/问号/感叹号之前的部分。
  text = text.split(/\r?\n/)[0]
  const firstSentence = text.match(/^[^。！？!?]*[。！？!?]?/)
  if (firstSentence !== null && firstSentence[0].trim() !== '') text = firstSentence[0]
  text = text.replace(/\s+/g, ' ').trim()

  if (text === '') return null
  if ([...text].length > MAX_LINE_CHARS) {
    text = [...text].slice(0, MAX_LINE_CHARS).join('').trim()
  }
  return text === '' ? null : text
}

/**
 * 没有模型时说的话。
 *
 * 这些句子也读时间，所以不会出现「凌晨三点说早安」。
 * 只在这一层兜底，不在模型可用时使用。
 */
export function fallbackLine(timeCtx, mood) {
  const byHour = timeCtx.hour
  const pool =
    byHour < 5
      ? ['这个点还醒着呀……要不要先喝口水？', '夜里很安静，人家就在这儿陪你。', '再不睡，明天会困的哦。']
      : byHour < 9
        ? ['早上好，今天也慢慢来就好。', '窗外的光刚亮起来呢。', '先伸个懒腰再开始吧。']
        : byHour < 12
          ? ['上午好呀，别一直坐着。', '手边有水吗？记得喝一口。', '忙归忙，也要喘口气。']
          : byHour < 14
            ? ['中午了，吃点东西吧。', '午后的风有点软呢。', '歇一会儿再继续，好不好？']
            : byHour < 18
              ? ['下午了，眼睛也该歇一歇。', '要不要站起来走两步？', '人家在这儿，不吵你。']
              : byHour < 23
                ? ['晚上好呀，今天辛苦了。', '灯光暗一点，眼睛会舒服些。', '忙完了就早点休息吧。']
                : ['夜深了，把今天放下吧。', '睡不着的话，人家陪你数星星。', '明天的事，明天再说。']

  if (mood !== null && mood.level === 'clingy') {
    pool.push('今天陪了你很久呢，有点开心。')
  }
  if (mood !== null && mood.level === 'bright') {
    pool.push('刚才那一下，人家记住啦。')
  }
  return pool[Math.floor(Math.random() * pool.length)]
}

/** 调一次模型。返回 { ok, line } 或 { ok: false, reason }，不抛错。 */
async function requestLine(options) {
  const {
    apiKey,
    model = 'deepseek-chat',
    prompt,
    fetchImpl = globalThis.fetch,
    timeoutMs = 20_000
  } = options

  const controller = typeof AbortController === 'function' ? new AbortController() : null
  const timer = controller === null ? null : setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(CHAT_ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: prompt.system },
          { role: 'user', content: prompt.user }
        ],
        max_tokens: 80,
        temperature: 1.05
      }),
      ...(controller === null ? {} : { signal: controller.signal })
    })
    if (!response.ok) return { ok: false, reason: `http-${response.status}` }
    const body = await response.json()
    // 先摘动作标记再清洗：清洗只留第一个句号前的内容，标记留在句末会被一起砍掉。
    const tagged = parseMotionTag(body?.choices?.[0]?.message?.content ?? '')
    const line = cleanBubbleLine(tagged.text)
    if (line === null) return { ok: false, reason: 'empty' }
    return { ok: true, line, motion: tagged.motion }
  } catch (error) {
    return { ok: false, reason: error?.name === 'AbortError' ? 'timeout' : 'network' }
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

/**
 * 情境服务。
 *
 * 依赖全部注入，主进程只负责提供设置、密钥和记忆摘要；
 * 这个模块不碰窗口，也不写文件，方便单测。
 */
export function createPresenceService(options) {
  const {
    getSettings,
    getApiKey,
    getMemoryDigest,
    getPersonaText,
    // 渲染层上报的动作能力；主进程不传就等于「没有动作可点」，提示词里也不会出现清单。
    getMotionCatalog = null,
    fetchImpl = globalThis.fetch,
    log = () => {},
    now = () => new Date()
  } = options

  let sessionStartedAt = now()
  let lastContactAt = null
  let weatherCache = null
  const recentLines = []

  function readSettings() {
    return getSettings() ?? {}
  }

  async function currentWeather() {
    const stamp = now().getTime()
    if (weatherCache !== null && stamp - weatherCache.at < WEATHER_TTL_MS) return weatherCache.value
    const city = readSettings()?.presence?.city
    const value = await fetchWeather({ city, fetchImpl })
    weatherCache = { at: stamp, value }
    return value
  }

  /** 记录一次互动，供心情与「别重复」使用。 */
  function noteContact(at = now()) {
    lastContactAt = at
  }

  function noteSpoken(line) {
    if (typeof line !== 'string' || line.trim() === '') return
    recentLines.push(line.trim())
    while (recentLines.length > 5) recentLines.shift()
  }

  /**
   * 生成下一句。
   *
   * reason：auto 定时开口 / manual 被点 / wake 窗口重新出现。
   * 无论哪条路径，返回的都是可以直接塞进气泡的一句话。
   */
  async function nextLine(reason = 'auto') {
    const settings = readSettings()
    const timeCtx = timeContext(now())
    const mood = moodSnapshot({
      now: now(),
      sessionStartedAt,
      lastContactAt,
      balanceLow: settings?.modules?.['builtin.balance']?.warnBelow > 0
    })

    const weather = settings?.presence?.useWeather === false ? null : await currentWeather()
    const prompt = buildBubblePrompt({
      nickname: settings?.nickname ?? '',
      personaText: typeof getPersonaText === 'function' ? getPersonaText(settings) : '',
      timeCtx,
      weather,
      mood,
      memoryDigest: typeof getMemoryDigest === 'function' ? getMemoryDigest() ?? '' : '',
      recentLines,
      // 渲染层探测到的真实动作能力；探测不到就是 null，模型那边不会出现动作清单。
      motions: typeof getMotionCatalog === 'function' ? getMotionCatalog() ?? null : null
    })

    let apiKey = ''
    try {
      apiKey = (await getApiKey()) ?? ''
    } catch (error) {
      log('[presence] 取密钥失败', String(error?.message ?? error))
    }

    if (apiKey === '') {
      const line = fallbackLine(timeCtx, mood)
      noteSpoken(line)
      return { ok: false, reason: 'no-key', line, source: 'fallback', timeCtx, mood, weather }
    }

    const result = await requestLine({
      apiKey,
      model: settings?.companion?.chat?.model ?? 'deepseek-chat',
      prompt,
      fetchImpl
    })
    if (result.ok === false) {
      log('[presence] 生成失败', result.reason)
      const line = fallbackLine(timeCtx, mood)
      noteSpoken(line)
      return { ok: false, reason: result.reason, line, source: 'fallback', timeCtx, mood, weather }
    }

    noteSpoken(result.line)
    return {
      ok: true,
      line: result.line,
      // AI 自己挑的动作；没挑就是 null，渲染层退回按心情驱动。
      motion: typeof result.motion === 'string' && result.motion !== '' ? result.motion : null,
      source: 'model',
      timeCtx,
      mood,
      weather
    }
  }

  /**
   * 状态栏用：只算心情，不取天气、不动网络。
   * 规则与 nextLine 里那份完全一致，避免状态栏和台词各说各的。
   */
  function currentMood() {
    const settings = readSettings()
    return moodSnapshot({
      now: now(),
      sessionStartedAt,
      lastContactAt,
      balanceLow: settings?.modules?.['builtin.balance']?.warnBelow > 0
    })
  }

  /** 设置页诊断用：此刻会给模型看什么。不含密钥。 */
  async function peekContext() {
    const settings = readSettings()
    const timeCtx = timeContext(now())
    const mood = moodSnapshot({ now: now(), sessionStartedAt, lastContactAt })
    const weather = settings?.presence?.useWeather === false ? null : await currentWeather()
    return {
      time: timeCtx,
      mood,
      weather,
      sessionMinutes: Math.max(0, Math.round((now().getTime() - sessionStartedAt.getTime()) / 60000)),
      recentLines: [...recentLines]
    }
  }

  return { nextLine, noteContact, noteSpoken, peekContext, currentMood }
}
