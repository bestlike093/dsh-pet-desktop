/**
 * 主动开口前的闸门：安静时段、每日上限、连续没回应就停。
 *
 * 纯函数 + 一个小状态机，不碰窗口、不读文件，方便单测。
 * 三条规则的优先级：安静时段 > 沉默放弃 > 每日上限。
 * 安静时段对手动触发同样生效；另外两条只拦自动开口。
 */

export const DEFAULT_QUIET = { enabled: true, start: '23:00', end: '07:00' }
export const DEFAULT_DAILY_CAP = 6
export const DEFAULT_SILENCE_DAYS = 3

/** "23:00" → 1380；格式不合法返回 null。 */
export function parseClock(text) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(text ?? '').trim())
  if (match === null) return null
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null
  return hours * 60 + minutes
}

/** 本地日期键，用来判断「今天」有没有翻页。 */
export function dayKey(now = new Date()) {
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * 此刻是否在安静时段内。
 * 支持跨午夜（23:00–07:00）；起止相同视为没设，直接放行。
 */
export function inQuietHours(now = new Date(), quiet = DEFAULT_QUIET) {
  if (quiet === null || quiet?.enabled === false) return false
  const start = parseClock(quiet?.start) ?? parseClock(DEFAULT_QUIET.start)
  const end = parseClock(quiet?.end) ?? parseClock(DEFAULT_QUIET.end)
  if (start === null || end === null || start === end) return false
  const current = now.getHours() * 60 + now.getMinutes()
  return start < end
    ? current >= start && current < end
    : current >= start || current < end
}

export function createPresenceGate({ now = () => new Date() } = {}) {
  let today = ''
  let spokenToday = 0

  function rollDay(nowDate) {
    const key = dayKey(nowDate)
    if (key === today) return
    today = key
    spokenToday = 0
  }

  /**
   * 该不该让她现在开口。
   *
   * @param {object} input
   * @param {object} input.settings 完整设置（只读 presence 段）
   * @param {string} input.reason auto / loop / manual / wake
   * @param {Date|null} input.lastContactAt 上次真正说话的时间
   * @returns {{ok:boolean, reason:string, detail:string}}
   */
  function check({ settings = {}, reason = 'auto', lastContactAt = null } = {}) {
    const nowDate = now()
    rollDay(nowDate)
    const presence = settings?.presence ?? {}

    if (inQuietHours(nowDate, presence.quietHours ?? DEFAULT_QUIET)) {
      return { ok: false, reason: 'quiet-hours', detail: '这个点她已经休息了' }
    }

    // 手动点她，是想现在听一句，不按「她该不该主动」那套算。
    if (reason === 'manual') return { ok: true, reason: 'ok', detail: '' }

    const silenceDays = Number.isFinite(presence.silenceDays)
      ? presence.silenceDays
      : DEFAULT_SILENCE_DAYS
    if (lastContactAt instanceof Date && silenceDays > 0) {
      const days = (nowDate.getTime() - lastContactAt.getTime()) / 86400000
      if (days >= silenceDays) {
        return {
          ok: false,
          reason: 'silent-away',
          detail: `已经 ${Math.floor(days)} 天没说话了，等她先开口`
        }
      }
    }

    const cap = Number.isFinite(presence.dailyCap) ? presence.dailyCap : DEFAULT_DAILY_CAP
    if (cap > 0 && spokenToday >= cap) {
      return { ok: false, reason: 'daily-cap', detail: `今天已经开口 ${spokenToday} 次` }
    }

    return { ok: true, reason: 'ok', detail: '' }
  }

  function noteSpoken() {
    rollDay(now())
    spokenToday += 1
  }

  function snapshot() {
    rollDay(now())
    return { day: today, spokenToday }
  }

  return { check, noteSpoken, snapshot }
}
