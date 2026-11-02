// 设置窗逻辑：读一次全量设置，之后每个控件改动即保存并立即生效。
// 这里不发任何网络请求，只走 preload 白名单方法。

// 主题只写 data-theme，具体颜色统一在 theme.css；这里不再维护第二张色表。

const $ = (id) => document.getElementById(id)

// 口令长度下限由 BackupPolicy 统一提供，HTML 的 minlength 只作静态兜底。
if ($('backup-password') !== null) {
  $('backup-password').minLength = BackupPolicy.PASSPHRASE_MIN_LENGTH
}

let current = null
let savedTipTimer = null

function t(key) {
  const locale = current?.locale ?? 'zh-CN'
  return window.PetI18n?.t(key, locale) ?? key
}

/** 导入失败的结构化原因码 → 文案；认不出的 code 回落到主进程原文。 */
const PACK_IMPORT_REASONS = {
  INPUT_MISSING: 'packs.reasonInputMissing',
  PATH_UNSAFE: 'packs.reasonPathUnsafe',
  MODEL_FILE: 'packs.reasonModelFile',
  FILE_TOO_LARGE: 'packs.reasonFileTooLarge',
  TOTAL_TOO_LARGE: 'packs.reasonTotalTooLarge',
  NO_RECOGNIZED: 'packs.reasonNoRecognized',
  EMPTY_AFTER_IMPORT: 'packs.reasonEmpty',
  MANIFEST_INVALID: 'packs.reasonManifest'
}

function packImportReason(code) {
  const key = PACK_IMPORT_REASONS[code]
  return key === undefined ? '' : t(key)
}

/**
 * 统一确认入口。normal 说明后果即可；danger 要求输入确认词。
 * 调用点集中在这里，之后换成自绘对话框时不用逐处改。
 */
function confirmAction({ message, strength = 'normal', confirmWord = '确认' }) {
  if (strength !== 'danger') return window.confirm(message)
  const answer = window.prompt(`${message}\n\n此操作不可撤销。请输入「${confirmWord}」继续。`, '')
  return answer !== null && answer.trim() === confirmWord
}

function applyI18n(locale) {
  window.PetI18n?.apply(locale)
}

const THEME_SHORT = { OceanBlue: 'blue', SakuraPink: 'pink', Paper: 'ink' }

// 一级导航只负责分组，真正的面板仍由 data-panel 决定。
// 旧深链（chat / voice / status …）全部保留，showPanel 负责把一级与子标签一起点亮。
const PANEL_GROUPS = {
  general: { labelKey: 'nav.general', panels: ['general', 'persona', 'language'] },
  dialogue: { labelKey: 'nav.dialogue', panels: ['chat', 'voice'] },
  companion: { labelKey: 'nav.companion', panels: ['companion'] },
  memory: { labelKey: 'nav.memory', panels: ['memory'] },
  ability: { labelKey: 'nav.ability', panels: ['ability', 'connection'] },
  system: { labelKey: 'nav.system', panels: ['data', 'status'] }
}

const PANEL_TO_GROUP = Object.fromEntries(
  Object.entries(PANEL_GROUPS).flatMap(([group, meta]) => meta.panels.map((panel) => [panel, group]))
)

const PANEL_META = {
  general: { titleKey: 'panel.general', descKey: 'page.general.desc' },
  persona: { titleKey: 'panel.persona', descKey: 'page.persona.desc' },
  language: { titleKey: 'panel.language', descKey: 'page.language.desc' },
  chat: { titleKey: 'panel.chat', descKey: 'page.chat.desc' },
  voice: { titleKey: 'panel.voice', descKey: 'page.voice.desc' },
  companion: { titleKey: 'panel.companion', descKey: 'page.companion.desc' },
  memory: { titleKey: 'panel.memory', descKey: 'page.memory.desc' },
  ability: { titleKey: 'panel.ability', descKey: 'page.ability.desc' },
  connection: { titleKey: 'panel.connection', descKey: 'page.connection.desc' },
  data: { titleKey: 'panel.data', descKey: 'page.data.desc' },
  status: { titleKey: 'panel.status', descKey: 'page.status.desc' }
}

let activePanel = 'general'
const lastPanelByGroup = {}

// 与 packages/shared/src/types/model.ts 的 SIZE_PROFILES 保持一致。
// 只用于把缩放倍数换算成像素读数，不改窗口尺寸的计算来源。
const SIZE_PROFILES = {
  vertical: { w: 600, h: 800 },
  horizontal: { w: 800, h: 450 },
  square: { w: 512, h: 512 },
  card: { w: 380, h: 240 }
}

function applyTheme(preset) {
  document.documentElement.dataset.theme = THEME_SHORT[preset] ?? 'pink'
  for (const button of document.querySelectorAll('#theme-seg button')) {
    button.classList.toggle('active', button.dataset.theme === preset)
  }
}

function renderPageHead(name) {
  const meta = PANEL_META[name] ?? PANEL_META.general
  const group = PANEL_TO_GROUP[name] ?? 'general'
  const groupLabel = $('page-group')
  const title = $('page-title')
  const desc = $('page-desc')
  if (groupLabel !== null) {
    groupLabel.dataset.i18n = PANEL_GROUPS[group].labelKey
    groupLabel.textContent = t(PANEL_GROUPS[group].labelKey)
  }
  if (title !== null) {
    title.dataset.i18n = meta.titleKey
    title.textContent = t(meta.titleKey)
  }
  if (desc !== null) {
    desc.dataset.i18n = meta.descKey
    desc.textContent = t(meta.descKey)
  }
}

/** 子标签只在多面板分组里出现；单面板分组把整条收掉，省一行高度。 */
function renderSubnav(group) {
  const subnav = $('subnav')
  if (subnav === null) return
  const meta = PANEL_GROUPS[group] ?? PANEL_GROUPS.general
  subnav.hidden = meta.panels.length <= 1
  for (const button of subnav.querySelectorAll('button[data-panel]')) {
    const visible = button.dataset.group === group
    button.hidden = !visible
    button.classList.toggle('active', visible && button.dataset.panel === activePanel)
  }
}

/**
 * 页头保存四态。成功与失败都走这里，页脚只保留「填写未提交」与错误原因，
 * 避免同一句「已保存」在上下两处同时闪。
 */
function setSaveState(state, detail = '') {
  const box = $('save-state')
  const text = $('save-state-text')
  if (box === null || text === null) return
  box.dataset.state = state
  text.dataset.i18n = `save.${state}`
  text.textContent = t(`save.${state}`)
  box.title = detail
}

/** 未开放区统一锁定：可见、可读、不可操作，不用假控件骗人。 */
function refreshLockedState() {
  const targets = document.querySelectorAll('.section.pending, .section[data-locked], .item[data-locked]')
  for (const target of targets) {
    target.classList.add('is-locked')
    target.setAttribute('aria-disabled', 'true')
    const reason = target.dataset.lockedReason || t('lock.reason')
    target.title = reason

    for (const control of target.querySelectorAll('input, select, button, textarea')) {
      control.disabled = true
      control.setAttribute('tabindex', '-1')
    }

    const host = target.querySelector('.section-title') ?? target.querySelector('.item-text')
    if (host !== null && host.querySelector('.locked-badge') === null) {
      const badge = document.createElement('span')
      badge.className = 'locked-badge'
      badge.dataset.i18n = 'lock.badge'
      badge.textContent = t('lock.badge')
      host.append(badge)
    }
  }
}

function showPanel(name) {
  const group = PANEL_TO_GROUP[name]
  if (group === undefined) return
  activePanel = name
  lastPanelByGroup[group] = name
  for (const button of document.querySelectorAll('#nav button[data-group]')) {
    button.classList.toggle('active', button.dataset.group === group)
  }
  for (const panel of document.querySelectorAll('.panel')) {
    panel.classList.toggle('active', panel.dataset.panel === name)
  }
  renderSubnav(group)
  renderPageHead(name)
  $('s-body').scrollTop = 0
  rememberPanel(name)
  // 列表与体检按需加载：不在首屏时不去动磁盘。
  if (name === 'memory') void refreshMemoryList()
  if (name === 'status') void refreshPreflight()
}

function showSaved() {
  const tip = $('saved-tip')
  if (tip !== null) {
    if (savedTipTimer !== null) {
      clearTimeout(savedTipTimer)
      savedTipTimer = null
    }
    tip.classList.remove('show', 'is-error')
  }
  setSaveState('saved')
}

/**
 * 未保存：设置是改动即存，所以这里的「未保存」只有一种真实含义——
 * 这次写盘失败了，而且还没重试成功。页头常驻错误态，页脚保留原因。
 */
function showUnsaved(detail = '') {
  const tip = $('saved-tip')
  setSaveState('error', detail)
  if (tip === null) return
  if (savedTipTimer !== null) {
    clearTimeout(savedTipTimer)
    savedTipTimer = null
  }
  tip.textContent = t('foot.unsaved')
  tip.classList.add('show', 'is-error')
}

// 余额模块和聊天都靠这一把钥匙。serviceId / field 要和主进程读的那一对保持一致，
// 改一处就得改两处。
const DEEPSEEK_SERVICE = 'deepseek'
const DEEPSEEK_FIELD = 'api_key'
const QQ_SECRET_SERVICE = 'qq-token'
const QQ_SECRET_FIELD = 'value'

/** QQ 主人名单按逗号 / 中文逗号 / 换行拆分，去空去重。 */
function readQqOwners() {
  const raw = String($('qq-owners')?.value ?? '')
  return [...new Set(raw.split(/[,，\n]/).map((item) => item.trim()).filter(Boolean))]
}

/** webhook 专用字段只在 webhook 模式下出现，避免网关模式误填。 */
function updateQqTransportVisibility() {
  const webhook = $('qq-transport')?.value === 'webhook'
  for (const node of document.querySelectorAll('[data-qq-webhook-only]')) {
    node.hidden = !webhook
  }
}

async function refreshQqMask() {
  const label = $('qq-secret-mask')
  if (label === null) return
  try {
    const result = await window.pet.getSecretMasked(QQ_SECRET_SERVICE, QQ_SECRET_FIELD)
    const masked = typeof result?.masked === 'string' ? result.masked : ''
    label.textContent = masked === '' ? t('qq.secretMissing') : `已保存 ${masked}`
  } catch (error) {
    label.textContent = `读取失败：${error instanceof Error ? error.message : String(error)}`
  }
}

/** 读回掩码写进提示行。没配是正常状态，写明「未配置」就够。 */
async function refreshDeepSeekMask() {
  const label = $('deepseek-mask')
  if (label === null) return
  try {
    const result = await window.pet.getSecretMasked(DEEPSEEK_SERVICE, DEEPSEEK_FIELD)
    const masked = typeof result?.masked === 'string' ? result.masked : ''
    label.textContent = masked === '' ? t('chat.keyMissing') : `已保存 ${masked}`
  } catch (error) {
    label.textContent = `读取失败：${error instanceof Error ? error.message : String(error)}`
  }
}

/**
 * 递归合并。companion 有若干层嵌套，浅合并会顺手把兄弟字段冲掉。
 * 数组与 null 直接替换，不做元素级合并。
 */
function mergeDeep(base, patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch
  const out = { ...(base !== null && typeof base === 'object' ? base : {}) }
  for (const [key, value] of Object.entries(patch)) {
    out[key] =
      value !== null && typeof value === 'object' && !Array.isArray(value)
        ? mergeDeep(out[key], value)
        : value
  }
  return out
}

/** 保存增量并回写本地副本。失败时不做乐观更新，避免界面显示假状态。 */
async function patch(partial, options = {}) {
  const merged = mergeDeep(current, partial)
  setSaveState('saving')
  try {
    current = await window.pet.saveSettings(merged)
    if (partial.locale !== undefined) {
      applyI18n(current.locale)
      document.title = t('app.title')
    }
    showSaved()
    if (options.applySize === true) {
      await window.pet.applyWindowSize()
    }
    return true
  } catch (error) {
    console.error('[settings] 保存失败', error)
    showUnsaved(error instanceof Error ? error.message : String(error))
    return false
  }
}

/**
 * 缩放读数：倍数 + 换算后的实际像素。
 * 像素按当前比例预设计算（CSS 像素，不含 zoomFactor），拿不到预设时退回竖屏。
 */
function renderScaleLabel(value) {
  const label = $('scale-value')
  if (label === null) return
  const scale = Number(value)
  const profile = $('profile')?.value ?? current?.profile ?? 'vertical'
  const base = SIZE_PROFILES[profile] ?? SIZE_PROFILES.vertical
  label.textContent = `${scale.toFixed(2)} · ${Math.round(base.w * scale)}×${Math.round(base.h * scale)}`
}

/** 滑杆旁边的数字。`<id>-value` 是该滑杆的读数节点。 */
function renderRangeLabel(id, value, digits = 1) {
  const label = $(`${id}-value`)
  if (label === null) return
  label.textContent = Number(value).toFixed(digits)
}

/** 缩放滑杆用百分比读数，比 0.85 这种小数更容易一眼看懂。 */
function renderPercentLabel(id, value) {
  const label = $(`${id}-value`)
  if (label === null) return
  label.textContent = `${Math.round(Number(value) * 100)}%`
}

// 与 packages/shared/src/types/settings.ts 的 DEFAULT_SETTINGS 对齐。
// section 上的 data-reset 按顶层键取这里的值，只覆盖该组涉及的字段。
const DEFAULT_PATCH = {
  nickname: '',
  profile: 'vertical',
  window: { scale: 0.7, alwaysOnTop: true, edgeSnap: true, edgeSnapDistance: 12 },
  bubble: {
    mode: 'rotate',
    fontSize: 14.5,
    radius: 10,
    alpha: 0.92,
    width: 300,
    height: 200,
    padding: 14,
    lineHeight: 1.5,
    fontFamily: '',
    stickerSize: 64,
    background: '',
    backgroundSlice: 12
  },
  live2dModelId: '',
  poseEverySeconds: 60,
  hudName: '昔涟',
  showHud: false,
  hudDetail: 'full',
  hudAlpha: 0.9,
  hudScale: 1,
  hudFontScale: 1,
  voice: {
    enabled: false,
    trigger: 'proactive',
    quietHours: { enabled: true, start: '22:00', end: '08:00' },
    provider: 'local',
    localUrl: 'http://127.0.0.1:9880',
    localProtocol: 'gpt-sovits',
    refAudioPath: '',
    promptLang: 'zh',
    cloud: { baseUrl: '', voice: '' },
    volume: 1,
    maxChars: 60,
    minIntervalSeconds: 8
  },
  'companion.memory': { enabled: false, maxItems: 500, summarizeEvery: 8 },
  'companion.persona': { enabled: true, extraPrompt: '' }
}

/** 「全部恢复默认」覆盖的字段；刻意不动主题、语言、引导状态与模块开关。 */
const RESET_ALL_KEYS = [
  'nickname',
  'profile',
  'window',
  'bubble',
  'live2dModelId',
  'poseEverySeconds',
  'hudName',
  'showHud',
  'hudDetail',
  'hudAlpha',
  'hudScale',
  'hudFontScale',
  'voice',
  'companion.memory',
  'companion.persona'
]

/** 把 a.b.c 这样的路径写进嵌套对象，供 patch 组装分组默认值。 */
function setPath(target, path, value) {
  const parts = path.split('.')
  let cursor = target
  for (let index = 0; index < parts.length - 1; index += 1) {
    cursor[parts[index]] = cursor[parts[index]] ?? {}
    cursor = cursor[parts[index]]
  }
  cursor[parts[parts.length - 1]] = value
}

const LAST_PANEL_KEY = 'pet.settings.panel'

/** 记住最后看的面板。隐私模式或配额满时读写会抛，忽略即可。 */
function rememberPanel(name) {
  try {
    window.localStorage.setItem(LAST_PANEL_KEY, name)
  } catch {
    // 存不下就算了，不影响本次操作
  }
}

function readLastPanel() {
  try {
    return window.localStorage.getItem(LAST_PANEL_KEY)
  } catch {
    return null
  }
}

/** 清空搜索高亮与隐藏，恢复完整列表。 */
function clearSearchFilter(restore = true) {
  for (const node of document.querySelectorAll('.is-search-hidden, .is-search-hit')) {
    node.classList.remove('is-search-hidden', 'is-search-hit')
  }
  for (const button of document.querySelectorAll('#nav button[data-group]')) {
    button.classList.remove('has-search-hit')
  }
  const empty = $('search-empty')
  if (empty !== null) empty.hidden = true
  const count = $('search-count')
  if (count !== null) {
    count.hidden = true
    count.textContent = ''
  }
  if (restore) showPanel(activePanel)
}

/** 按关键词过滤条目：命中保留，整组无命中时连 section 一起隐藏。 */
function runSearch(rawQuery) {
  const query = rawQuery.trim().toLowerCase()
  if (query === '') {
    clearSearchFilter(true)
    return
  }
  clearSearchFilter(false)

  let total = 0
  const groupsWithHits = new Set()
  for (const panel of document.querySelectorAll('.panel')) {
    let panelHits = 0
    for (const section of panel.querySelectorAll('.section')) {
      let sectionHits = 0
      for (const item of section.querySelectorAll('.item')) {
        const text = (item.textContent ?? '').toLowerCase()
        const matched = text.includes(query)
        item.classList.toggle('is-search-hidden', !matched)
        item.classList.toggle('is-search-hit', matched)
        if (matched) sectionHits += 1
      }
      section.classList.toggle('is-search-hidden', sectionHits === 0)
      // 命中的 section 可能藏在默认折叠的分组里，先展开，否则等于搜不到
      if (sectionHits > 0) {
        const group = section.closest('details.section-group')
        if (group !== null) group.open = true
      }
      panelHits += sectionHits
    }
    panel.classList.toggle('is-search-hidden', panelHits === 0)
    if (panelHits > 0) {
      const group = PANEL_TO_GROUP[panel.dataset.panel]
      if (group !== undefined) groupsWithHits.add(group)
    }
    total += panelHits
  }

  for (const button of document.querySelectorAll('#nav button[data-group]')) {
    button.classList.toggle('has-search-hit', groupsWithHits.has(button.dataset.group))
  }

  const count = $('search-count')
  if (count !== null) {
    count.hidden = false
    count.textContent = total === 0 ? t('nav.searchNone') : String(total)
  }

  const empty = $('search-empty')
  if (total === 0) {
    if (empty !== null) empty.hidden = false
    for (const panel of document.querySelectorAll('.panel')) panel.classList.remove('active')
    for (const button of document.querySelectorAll('#nav button[data-group]')) {
      button.classList.remove('active')
    }
    const subnav = $('subnav')
    if (subnav !== null) subnav.hidden = true
    const groupLabel = $('page-group')
    const title = $('page-title')
    const desc = $('page-desc')
    if (groupLabel !== null) {
      groupLabel.dataset.i18n = 'nav.search'
      groupLabel.textContent = t('nav.search')
    }
    if (title !== null) {
      title.dataset.i18n = 'search.emptyTitle'
      title.textContent = t('search.emptyTitle')
    }
    if (desc !== null) {
      desc.dataset.i18n = 'search.emptyHint'
      desc.textContent = t('search.emptyHint')
    }
    return
  }

  if (empty !== null) empty.hidden = true
  const first = [...document.querySelectorAll('.panel')].find(
    (panel) => !panel.classList.contains('is-search-hidden')
  )
  if (first !== undefined) {
    showPanel(first.dataset.panel)
    const anchor = first.querySelector('.item.is-search-hit')
    if (anchor !== null) {
      // 等面板切换与 details 展开完成后再滚，避免被 sticky 页头算错位置。
      requestAnimationFrame(() => anchor.scrollIntoView({ block: 'center', behavior: 'auto' }))
    }
  }
}

/** 把某个 section 涉及的字段恢复成默认值。 */
async function resetSection(button) {
  const keys = (button.dataset.reset ?? '')
    .split(',')
    .map((key) => key.trim())
    .filter((key) => key !== '' && Object.prototype.hasOwnProperty.call(DEFAULT_PATCH, key))
  if (keys.length === 0) return

  const partial = {}
  for (const key of keys) setPath(partial, key, DEFAULT_PATCH[key])
  const ok = await patch(partial, { applySize: true })
  if (!ok) return
  await loadSettings()
  renderScaleLabel($('scale').value)
}

/** 整窗恢复默认：只覆盖可编辑的外观与陪伴项，不动主题、语言与模块开关。 */
async function resetAllSettings() {
  if (
    !confirmAction({
      message: '把昵称、外观、气泡、立绘、HUD、语音、记忆与人格设置恢复成默认？主题、语言和模块开关保持不变。',
      strength: 'danger',
      confirmWord: '全部复位'
    })
  ) {
    return
  }
  const partial = {}
  for (const key of RESET_ALL_KEYS) setPath(partial, key, DEFAULT_PATCH[key])
  const ok = await patch(partial, { applySize: true })
  if (!ok) return
  await loadSettings()
  renderScaleLabel($('scale').value)
}

/** ISO 时间转本地可读文本；空串或坏值回空串，界面据此显示占位文案。 */
function formatSyncTime(iso) {
  if (typeof iso !== 'string' || iso === '') return ''
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString()
}

/**
 * 填写未提交的标记。
 * 这三类输入不会即时落盘：API Key 要按保存，备份口令只在本次导出/恢复时用，
 * 人格额外说明是 change 时自动保存。和 foot.unsaved 的「写盘失败」是两回事。
 */
const pendingInputs = new Set()

function refreshPendingTip() {
  const tip = $('pending-tip')
  if (tip === null) return
  tip.hidden = pendingInputs.size === 0
}

function markPending(id) {
  pendingInputs.add(id)
  refreshPendingTip()
}

function clearPending(id) {
  pendingInputs.delete(id)
  refreshPendingTip()
}

/** 给还没有恢复按钮的主要分组补一个；已有按钮的分组不重复注入。 */
const SECTION_RESET_DEFAULTS = [
  ['general.model', 'live2dModelId'],
  ['general.hud', 'hudName,showHud,hudDetail,hudAlpha,hudScale,hudFontScale'],
  ['voice.title', 'voice'],
  ['memory.title', 'companion.memory'],
  ['persona.title', 'companion.persona']
]

function injectSectionResets() {
  for (const [titleKey, keys] of SECTION_RESET_DEFAULTS) {
    const title = document.querySelector(`.section-title[data-i18n="${titleKey}"]`)
    const section = title?.closest('.section')
    if (section === null || section === undefined) continue
    if (section.querySelector('.section-reset') !== null) continue
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'section-reset'
    button.dataset.reset = keys
    button.dataset.i18n = 'general.reset'
    button.textContent = t('general.reset')
    button.addEventListener('click', () => {
      void resetSection(button)
    })
    section.append(button)
  }
}

/** 从 packs 清单里找 pack:<id>:<file> 对应的条目。 */
function findPackItem(kind, value) {
  const match = /^pack:([^:]+):(.+)$/.exec(value ?? '')
  if (match === null) return null
  const [, id, file] = match
  const pack = packs.find((item) => item.id === id)
  return (pack?.files?.[kind] ?? []).find((item) => item.file === file) ?? null
}

/** 气泡预览：把当前滑杆与素材选择直接映射到示例气泡上。 */
function renderBubblePreview() {
  const balloon = $('bubble-preview-balloon')
  if (balloon === null) return

  const fontSize = Number($('bubble-fontSize')?.value ?? 14.5)
  const radius = Number($('bubble-radius')?.value ?? 10)
  const alpha = Number($('bubble-alpha')?.value ?? 0.92)
  balloon.style.fontSize = `${fontSize}px`
  // 宽度 0 = 跟随预览容器；非 0 时按设置值收窄，和主界面的 max-width 同一套语义。
  const previewWidth = Number($('bubble-width')?.value ?? 300)
  balloon.style.maxWidth = previewWidth > 0 ? `${previewWidth}px` : '100%'
  balloon.style.borderRadius = `${radius}px`
  balloon.style.opacity = String(alpha)

  const background = findPackItem('bubble', $('bubble-background')?.value ?? '')
  balloon.style.backgroundImage = background === null ? '' : `url("${background.url}")`
  balloon.classList.toggle('has-background', background !== null)

  const font = findPackItem('font', $('bubble-font')?.value ?? '')
  balloon.style.fontFamily = font?.family ?? ''
  balloon.classList.toggle('has-font', font !== null)

  // 切片与底图同一处回显：预览用九宫格边框图，改切片立刻能看到四角变化
  const slice = Number($('bubble-slice')?.value ?? 12)
  balloon.style.setProperty('--preview-slice', `${Number.isFinite(slice) ? slice : 12}px`)
  balloon.style.setProperty(
    '--preview-image',
    background === null ? 'none' : `url("${background.url}")`
  )

  // 贴纸跟着下拉走；没选就收起，避免留下一张过期的图
  const sticker = findPackItem('emoji', $('sticker-source')?.value ?? '')
  const stickerImage = $('bubble-preview-sticker')
  if (stickerImage !== null) {
    stickerImage.hidden = sticker === null
    stickerImage.src = sticker === null ? '' : sticker.url
  }
}

async function loadSettings() {
  current = await window.pet.getSettings()
  applyI18n(current.locale ?? 'zh-CN')
  document.title = t('app.title')

  $('nickname').value = current.nickname ?? ''
  applyTheme(current.theme?.preset ?? 'SakuraPink')

  const profile = current.profile ?? 'vertical'
  $('profile').value = profile === 'custom' ? 'vertical' : profile

  const scale = Number(current.window?.scale ?? 0.7)
  $('scale').value = String(scale)
  renderScaleLabel(scale)

  $('alwaysOnTop').checked = Boolean(current.window?.alwaysOnTop)
  $('edgeSnap').checked = Boolean(current.window?.edgeSnap)
  $('edgeSnapDistance').value = String(current.window?.edgeSnapDistance ?? 12)

  // 换立绘间隔：下拉只有五档，旧配置里的其他数字归一到最近的可选档。
  const poseOptions = [0, 30, 60, 120, 300]
  const rawPoseEvery = Number(current.poseEverySeconds ?? 60)
  const poseEvery = poseOptions.includes(rawPoseEvery)
    ? rawPoseEvery
    : poseOptions.reduce(
        (best, item) =>
          Math.abs(item - rawPoseEvery) < Math.abs(best - rawPoseEvery) ? item : best,
        60
      )
  $('poseEverySeconds').value = String(poseEvery)

  // 气泡
  const bubble = current.bubble ?? {}
  $('bubble-mode').value = bubble.mode ?? 'rotate'
  $('bubble-fontSize').value = String(bubble.fontSize ?? 14.5)
  renderRangeLabel('bubble-fontSize', bubble.fontSize ?? 14.5, 1)
  $('bubble-radius').value = String(bubble.radius ?? 10)
  renderRangeLabel('bubble-radius', bubble.radius ?? 10, 0)
  $('bubble-alpha').value = String(bubble.alpha ?? 0.92)
  renderRangeLabel('bubble-alpha', bubble.alpha ?? 0.92, 2)
  $('bubble-width').value = String(bubble.width ?? 300)
  renderRangeLabel('bubble-width', bubble.width ?? 300, 0)
  $('bubble-stickerSize').value = String(bubble.stickerSize ?? 64)
  renderRangeLabel('bubble-stickerSize', bubble.stickerSize ?? 64, 0)

  // HUD：showHud 是唯一显隐真源；老配置里的 off 视为关闭。
  const hudOff = current.hudDetail === 'off'
  $('hudName').value = current.hudName ?? '昔涟'
  $('showHud').checked = current.showHud === true && !hudOff
  // 老配置里的 simple 就是新的「紧凑」档，off 归一到紧凑，避免下拉框空着。
  $('hudDetail').value =
    current.hudDetail === 'simple' || hudOff ? 'compact' : (current.hudDetail ?? 'compact')
  $('hudAlpha').value = String(current.hudAlpha ?? 0.9)
  renderRangeLabel('hudAlpha', current.hudAlpha ?? 0.9, 2)
  $('hudScale').value = String(current.hudScale ?? 1)
  renderPercentLabel('hudScale', current.hudScale ?? 1)
  $('hudFontScale').value = String(current.hudFontScale ?? 1)
  renderPercentLabel('hudFontScale', current.hudFontScale ?? 1)

  // 模块开关
  const modules = current.modules ?? {}
  $('module-bubble').checked = modules['builtin.bubble']?.enabled !== false
  $('module-reminder').checked = modules['builtin.reminder']?.enabled !== false
  $('module-balance').checked = modules['builtin.balance']?.enabled === true

  // 语音：缺字段一律按「不出声」处理，避免旧配置被误读成开着
  const voice = current.voice ?? {}
  $('voice-enabled').checked = voice.enabled === true
  $('voice-trigger').value = voice.trigger ?? 'proactive'

  const quiet = voice.quietHours ?? {}
  $('voice-quiet-enabled').checked = quiet.enabled !== false
  $('voice-quiet-start').value = quiet.start ?? '22:00'
  $('voice-quiet-end').value = quiet.end ?? '08:00'

  // 本地合成：地址只连回环，参考音频空着就静默不出声。
  $('voice-local-url').value = voice.localUrl ?? 'http://127.0.0.1:9880'
  $('voice-ref-audio').value = voice.refAudioPath ?? ''
  $('voice-volume').value = String(voice.volume ?? 1)
  renderRangeLabel('voice-volume', voice.volume ?? 1, 2)
  $('voice-max-chars').value = String(voice.maxChars ?? 60)
  $('voice-min-interval').value = String(voice.minIntervalSeconds ?? 8)

  // 语言
  $('locale').value = current.locale ?? 'zh-CN'

  // 主动台词
  const presence = current.presence ?? {}
  $('presence-ai-enabled').checked = presence.aiEnabled === true
  $('presence-interval').value = String(presence.intervalMinutes ?? 12)
  $('presence-city').value = presence.city ?? ''
  // 默认开着天气：这是「结合此刻」里最直观的一项。
  $('presence-weather').checked = presence.useWeather !== false

  const quietSettings = presence.quiet ?? {}
  $('quiet-enabled').checked = quietSettings.enabled === true
  $('quiet-from').value = typeof quietSettings.from === 'string' ? quietSettings.from : '23:00'
  $('quiet-to').value = typeof quietSettings.to === 'string' ? quietSettings.to : '08:00'
  // 只认三种已知方式；旧配置或手改出错时回落到「保留提醒」。
  $('quiet-mode').value =
    quietSettings.mode === 'silent' || quietSettings.mode === 'reduce'
      ? quietSettings.mode
      : 'urgentOnly'
  $('quiet-hide-hud').checked = quietSettings.hideHud === true

  // 陪伴：四组任务与预算
  const companion = current.companion ?? {}
  const care = companion.care ?? {}

  $('care-daily-review-enabled').checked = care.dailyReview?.enabled === true
  $('care-daily-review-at').value = care.dailyReview?.at ?? '22:30'
  $('care-case-review-enabled').checked = care.caseReview?.enabled === true
  $('care-case-review-at').value = care.caseReview?.at ?? '23:00'
  $('care-questionnaire-enabled').checked = care.questionnaire?.enabled === true
  $('care-maslow-enabled').checked = care.maslow?.enabled === true
  $('care-budget').value = String(care.dailyTokenBudget ?? 20_000)

  // 情绪与反思：默认关闭，缺字段时按默认值显示。
  const emotion = companion.emotion ?? {}
  const afterglow = emotion.afterglow ?? {}
  $('emotion-afterglow-enabled').checked = afterglow.enabled === true
  $('emotion-afterglow-half-life').value = String(afterglow.halfLifeMinutes ?? 30)
  $('emotion-expression-group').value = emotion.expression?.group ?? 'off'
  $('emotion-needs-enabled').checked = emotion.needs?.enabled === true

  // 记忆
  const memory = companion.memory ?? {}
  $('memory-enabled').checked = memory.enabled === true
  $('memory-max-items').value = String(memory.maxItems ?? 500)
  $('memory-summarize-every').value = String(memory.summarizeEvery ?? 8)

  // 聊天
  const chat = companion.chat ?? {}
  $('chat-enabled').checked = chat.enabled === true
  $('chat-model').value = chat.model ?? 'deepseek-chat'
  $('chat-max-tokens').value = String(chat.maxTokens ?? 800)
  $('chat-temperature').value = String(chat.temperature ?? 0.8)
  renderRangeLabel('chat-temperature', chat.temperature ?? 0.8, 1)
  $('chat-history-limit').value = String(chat.historyLimit ?? 10)

  // 人格
  const persona = companion.persona ?? {}
  $('persona-enabled').checked = persona.enabled !== false
  $('persona-extra').value = persona.extraPrompt ?? ''
  updatePersonaCount()
  void renderPersonaPreview()

  // QQ：凭据本体在 Vault，这里只回显 appId、主人名单与传输方式。
  const qq = current.channels?.qq ?? {}
  $('qq-enabled').checked = qq.enabled === true
  $('qq-transport').value = qq.transport === 'webhook' ? 'webhook' : 'gateway'
  updateQqTransportVisibility()
  $('qq-app-id').value = qq.appId ?? ''
  $('qq-owners').value = Array.isArray(qq.ownerOpenIds) ? qq.ownerOpenIds.join(', ') : ''
  $('qq-target').value = qq.targetOpenId ?? ''
  $('qq-public-key').value = qq.publicKey ?? ''
  $('qq-port').value = String(qq.webhookPort ?? 8787)

  await refreshModels()
  await refreshDeepSeekMask()
  await refreshQqMask()
  await refreshMemoryStats()
  await refreshCareStatus()
}

/** 立绘区：拉模型列表填下拉，并把「装了没 / 可用几个 / 放在哪」写清楚。 */
async function refreshModels() {
  const select = $('live2d-model')
  const status = $('model-status')
  try {
    const result = await window.pet.listModels()
    if (result?.ok !== true) {
      status.textContent = `读取模型失败：${result?.message ?? '未知原因'}`
      return
    }

    const models = Array.isArray(result.models) ? result.models : []
    const activeId = current?.live2dModelId ?? ''

    select.innerHTML = ''
    const none = document.createElement('option')
    none.value = ''
    none.textContent = t('general.modelNone')
    select.appendChild(none)

    for (const model of models) {
      const option = document.createElement('option')
      option.value = model.id
      option.textContent = model.valid ? model.name : `${model.name}（不可用）`
      option.disabled = model.valid !== true
      select.appendChild(option)
    }
    select.value = models.some((model) => model.id === activeId) ? activeId : ''

    if (models.length === 0) {
      status.textContent = t('general.modelEmpty')
    } else {
      const usable = models.filter((model) => model.valid).length
      status.textContent = `已导入 ${models.length} 个模型，其中 ${usable} 个可用。目录：${result.root}`
    }

    renderModelGrid(models)
  } catch (error) {
    status.textContent = `读取模型失败：${error instanceof Error ? error.message : String(error)}`
  }
}

/**
 * 立绘缩略图：只画带 preview 的模型，没有预览图就不占位置。
 * 点击写回下拉框，仍然走同一条 setActiveModel 路径。
 */
function renderModelGrid(models) {
  const grid = $('model-grid')
  const select = $('live2d-model')
  if (grid === null || select === null) return
  grid.replaceChildren()

  const withPreview = models.filter(
    (model) => typeof model.preview === 'string' && model.preview !== ''
  )
  if (withPreview.length === 0) return

  for (const model of withPreview) {
    const tile = document.createElement('button')
    tile.type = 'button'
    tile.className = 'asset-tile'
    tile.dataset.value = model.id
    tile.title = model.valid ? model.name : `${model.name}（不可用）`
    tile.disabled = model.valid !== true

    const image = document.createElement('img')
    image.src = model.preview
    image.alt = model.name
    image.loading = 'lazy'

    const label = document.createElement('span')
    label.textContent = model.name

    tile.append(image, label)
    tile.addEventListener('click', () => {
      if (model.valid !== true) return
      select.value = model.id
      syncModelGridActive()
      select.dispatchEvent(new Event('change'))
    })
    grid.append(tile)
  }

  syncModelGridActive()
}

function syncModelGridActive() {
  const grid = $('model-grid')
  const select = $('live2d-model')
  if (grid === null || select === null) return
  for (const tile of grid.querySelectorAll('.asset-tile')) {
    tile.classList.toggle('is-active', tile.dataset.value === select.value)
  }
}

/** 记忆统计：接口缺失写「尚未接入」，加密不可用写「不可用」，不写假的 0。 */
async function refreshMemoryStats() {
  const count = $('memory-count')
  const updated = $('memory-updated')
  if (typeof window.pet.getMemoryStats !== 'function') {
    count.textContent = '尚未接入'
    updated.textContent = '—'
    return
  }
  try {
    const stats = await window.pet.getMemoryStats()
    if (stats?.available === false) {
      count.textContent = '不可用（加密仓库未装配）'
      updated.textContent = '—'
      return
    }
    count.textContent = `${stats?.count ?? 0} / ${stats?.limit ?? '—'}`
    updated.textContent = stats?.updatedAt ?? '尚未写入'
  } catch (error) {
    count.textContent = `读取失败：${error instanceof Error ? error.message : String(error)}`
  }
}

const MEMORY_PAGE_SIZE = 20
let memoryOffset = 0
let memoryQuery = ''
let memoryRole = ''
let memoryFrom = ''
let memoryTo = ''
let memoryTotal = 0

/** 是否有任何筛选条件；决定空态文案与「条匹配」单位。 */
function memoryFiltering() {
  return memoryQuery !== '' || memoryRole !== '' || memoryFrom !== '' || memoryTo !== ''
}

/** 记忆列表：最新在前，只显示文本；渲染用 textContent，不拼 HTML。 */
async function refreshMemoryList() {
  const box = $('memory-list')
  const page = $('memory-page')
  if (box === null) return

  if (typeof window.pet.listMemory !== 'function') {
    box.textContent = t('memory.unsupported')
    if (page !== null) page.textContent = '—'
    return
  }

  try {
    const result = await window.pet.listMemory({
      offset: memoryOffset,
      limit: MEMORY_PAGE_SIZE,
      query: memoryQuery,
      role: memoryRole,
      from: memoryFrom,
      to: memoryTo
    })
    if (result?.ok === false) {
      memoryTotal = 0
      box.textContent =
        result.reason === 'vault-unavailable' ? t('memory.vaultUnavailable') : t('memory.readFailed')
      if (page !== null) page.textContent = '—'
      return
    }

    const items = Array.isArray(result?.items) ? result.items : []
    memoryTotal = Number.isFinite(Number(result?.total)) ? Number(result.total) : 0
    box.textContent = ''

    if (items.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'memory-empty'
      empty.textContent =
        memoryTotal !== 0
          ? t('memory.emptyPage')
          : t(memoryFiltering() ? 'memory.emptyMatch' : 'memory.emptyTotal')
      box.append(empty)
    }

    for (const item of items) {
      const row = document.createElement('div')
      row.className = 'memory-row'

      const meta = document.createElement('div')
      meta.className = 'memory-meta'
      const when = typeof item.at === 'string' && item.at !== '' ? item.at : t('memory.timeUnknown')
      meta.textContent = `${item.role === 'user' ? t('memory.you') : t('memory.her')} · ${when}`

      const text = document.createElement('div')
      text.className = 'memory-text'
      text.textContent = typeof item.text === 'string' ? item.text : ''

      const remove = document.createElement('button')
      remove.type = 'button'
      remove.textContent = t('memory.delete')
      remove.addEventListener('click', () => {
        void deleteMemoryEntry(item.id)
      })

      row.append(meta, text, remove)
      box.append(row)
    }

    if (page !== null) {
      const pages = Math.max(1, Math.ceil(memoryTotal / MEMORY_PAGE_SIZE))
      const currentPage = Math.floor(memoryOffset / MEMORY_PAGE_SIZE) + 1
      const unit = t(memoryFiltering() ? 'memory.pageUnitMatch' : 'memory.pageUnit')
      page.textContent = `${t('memory.pagePrefix')}${currentPage}${t('memory.pageMiddle')}${pages}${t(
        'memory.pageSuffix'
      )} · ${memoryTotal}${unit}`
    }
  } catch (error) {
    box.textContent = `${t('memory.readFailed')}：${
      error instanceof Error ? error.message : String(error)
    }`
    if (page !== null) page.textContent = '—'
  }
}

async function exportMemory() {
  const status = $('memory-export-status')
  if (typeof window.pet.exportMemory !== 'function') return
  try {
    const result = await window.pet.exportMemory({
      query: memoryQuery,
      role: memoryRole,
      from: memoryFrom,
      to: memoryTo
    })
    if (result?.canceled === true) return
    if (result?.ok !== true) {
      if (status !== null) {
        status.textContent =
          result?.code === 'MEMORY_EMPTY'
            ? t('memory.exportEmpty')
            : `${t('memory.exportFailed')} · ${result?.message ?? result?.code ?? ''}`
      }
      return
    }
    if (status !== null) status.textContent = `${t('memory.exported')} · ${result.path}`
  } catch (error) {
    if (status !== null) {
      status.textContent = `${t('memory.exportFailed')} · ${
        error instanceof Error ? error.message : String(error)
      }`
    }
  }
}

/** 删除单条：删完按剩余总数修正页码，再刷新统计与列表。 */
async function deleteMemoryEntry(id) {
  if (typeof window.pet.deleteMemory !== 'function') return
  try {
    const result = await window.pet.deleteMemory(id)
    if (result?.ok === false && result.reason !== 'not-found') return
    if (memoryOffset > 0 && memoryTotal <= memoryOffset + 1) {
      memoryOffset = Math.max(0, memoryOffset - MEMORY_PAGE_SIZE)
    }
    await refreshMemoryStats()
    await refreshMemoryList()
  } catch {
    // 删除失败时保持现状；下一次刷新会显示真实结果。
  }
}

/** 字节数只用于体检展示，不做精确单位换算。 */
function formatBytes(value) {
  const bytes = Number(value)
  if (!Number.isFinite(bytes) || bytes <= 0) return '—'
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let scaled = bytes
  let index = 0
  while (scaled >= 1024 && index < units.length - 1) {
    scaled /= 1024
    index += 1
  }
  return `${scaled.toFixed(index === 0 ? 0 : 1)} ${units[index]}`
}

const VOICE_PROVIDER_LABEL = { off: '关闭', local: '本地', cloud: '云端' }

/** 启动前体检：只展示主进程返回的真实字段，缺项写「不可用」。 */
async function refreshPreflight() {
  const fields = ['chat', 'models', 'secret', 'voice', 'disk', 'vault', 'memory']
  if (typeof window.pet.preflight !== 'function') {
    for (const field of fields) {
      const element = $(`preflight-${field}`)
      if (element !== null) element.textContent = '尚未接入'
    }
    return
  }

  try {
    const info = await window.pet.preflight()
    if (info?.ok !== true) {
      for (const field of fields) {
        const element = $(`preflight-${field}`)
        if (element !== null) element.textContent = '检查失败'
      }
      return
    }

    const chat = info.chat ?? {}
    $('preflight-chat').textContent =
      chat.historyPersisted === true
        ? `已加密落盘 · ${chat.historyCount ?? 0} 条`
        : `仅内存 · ${chat.historyCount ?? 0} 条`

    const models = info.models ?? {}
    $('preflight-models').textContent =
      typeof models.error === 'string'
        ? '不可用'
        : models.count > 0
          ? `${models.count} 个${models.activeValid ? ' · 当前可用' : ' · 当前未选中或不可用'}`
          : '未导入'

    const secret = info.secret ?? {}
    $('preflight-secret').textContent =
      typeof secret.error === 'string'
        ? '不可用'
        : secret.configured === true
          ? `已配置 ${secret.masked ?? ''}`.trim()
          : '未配置'

    const voice = info.voice ?? {}
    $('preflight-voice').textContent = `${VOICE_PROVIDER_LABEL[voice.provider] ?? voice.provider ?? '—'}${voice.endpointConfigured === true ? ' · 地址已填' : ' · 地址未填'}`

    const disk = info.disk ?? {}
    $('preflight-disk').textContent = Number.isFinite(disk.freeBytes)
      ? `剩余 ${formatBytes(disk.freeBytes)} / 共 ${formatBytes(disk.totalBytes)}`
      : '不可用'

    $('preflight-vault').textContent = describeKeyRingState(info.vault)

    const memory = info.memory ?? {}
    $('preflight-memory').textContent =
      memory.available === false ? '不可用' : `${memory.count ?? 0} / ${memory.limit ?? '—'}`
  } catch (error) {
    for (const field of fields) {
      const element = $(`preflight-${field}`)
      if (element !== null) element.textContent = '检查失败'
    }
    console.error('[settings] 体检读取失败', error)
  }
}

/** 陪伴任务状态：没跑过就写「尚未运行」。 */
async function refreshCareStatus() {
  const last = $('care-last-run')
  const next = $('care-next-run')
  const result = $('care-last-result')
  if (typeof window.pet.careStatus !== 'function') {
    last.textContent = '尚未接入'
    next.textContent = '—'
    result.textContent = '尚未运行'
    return
  }
  try {
    const status = await window.pet.careStatus()
    last.textContent = status?.lastRunAt ?? '尚未运行'
    next.textContent = status?.nextRunAt ?? '—'
    result.textContent = status?.lastSummary ?? '尚未运行'
  } catch (error) {
    last.textContent = `读取失败：${error instanceof Error ? error.message : String(error)}`
  }
}

/** 人格额外说明的字数：随输入实时更新，上限取自 textarea 自身。 */
function updatePersonaCount() {
  const field = $('persona-extra')
  const counter = $('persona-count')
  if (field === null || counter === null) return
  const max = field.maxLength > 0 ? field.maxLength : 2000
  const used = field.value.length
  counter.textContent = `${used} / ${max}`
  counter.classList.toggle('is-near', used >= max * 0.9 && used < max)
  counter.classList.toggle('is-full', used >= max)
}

/**
 * 人格预览。
 * 文本由主进程的人格模块拼装，这里原样展示；
 * 接口不可用时退回本地拼一份，并注明是简版。
 */
async function renderPersonaPreview() {
  const box = $('persona-preview')
  const persona = current?.companion?.persona ?? {}
  if (persona.enabled === false) {
    box.textContent = '人格提示词已关闭，只使用最基础的语气设定。'
    return
  }

  if (typeof window.pet.getPersonaPreview === 'function') {
    try {
      const result = await window.pet.getPersonaPreview()
      if (typeof result?.text === 'string' && result.text.trim() !== '') {
        box.textContent = result.text
        return
      }
    } catch {
      // 回退到下面的本地简版，不把错误页塞给用户。
    }
  }

  const extra = (persona.extraPrompt ?? '').trim()
  const lines = ['（主进程预览不可用，下面是简版）']
  if (extra !== '') lines.push(`补充设定：${extra}`)
  box.textContent = lines.join('\n')
}

function bindEvents() {
  // 左侧一级导航：只切分组，落到该组上次停留的面板。
  $('nav').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-group]')
    if (button === null) return
    const group = button.dataset.group
    const meta = PANEL_GROUPS[group]
    if (meta === undefined) return
    const search = $('settings-search')
    if (search !== null && search.value !== '') {
      search.value = ''
      clearSearchFilter(false)
    }
    showPanel(lastPanelByGroup[group] ?? meta.panels[0])
  })

  // 组内子标签：只切面板，不动一级高亮。
  $('subnav')?.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-panel]')
    if (button === null) return
    const search = $('settings-search')
    if (search !== null && search.value !== '') {
      search.value = ''
      clearSearchFilter(false)
    }
    showPanel(button.dataset.panel)
  })

  // 素材包：导入 / 刷新 / 四类来源选择
  bindPackEvents()

  // 立绘：切换 / 导入 / 打开目录
  $('live2d-model').addEventListener('change', async () => {
    const modelId = $('live2d-model').value
    const result = await window.pet.setActiveModel(modelId)
    if (result?.ok === true) {
      current = { ...current, live2dModelId: result.live2dModelId ?? '' }
      showSaved()
    } else {
      $('model-status').textContent = `切换失败：${result?.message ?? '未知原因'}`
      await refreshModels()
    }
  })

  const doImport = async (kind) => {
    const ids = ['import-model-zip', 'import-model-folder']
    for (const id of ids) $(id).disabled = true
    $('model-status').textContent =
      kind === 'zip' ? '正在解压并校验模型……' : '正在复制并校验模型……'

    try {
      const result = await window.pet.importModel(kind)
      if (result?.canceled === true) {
        $('model-status').textContent = '已取消导入'
        return
      }
      if (result?.ok !== true) {
        $('model-status').textContent = `导入失败：${result?.message ?? '未知原因'}`
        return
      }
      current = { ...current, live2dModelId: result.model?.id ?? '' }
      await refreshModels()
      showSaved()
    } catch (error) {
      $('model-status').textContent = `导入失败：${error instanceof Error ? error.message : String(error)}`
    } finally {
      for (const id of ids) $(id).disabled = false
    }
  }

  $('import-model-zip').addEventListener('click', () => {
    void doImport('zip')
  })

  $('import-model-folder').addEventListener('click', () => {
    void doImport('folder')
  })

  $('open-models-folder').addEventListener('click', async () => {
    const result = await window.pet.openModelsFolder()
    if (result?.ok !== true) {
      $('model-status').textContent = `打不开模型目录：${result?.message ?? '未知原因'}`
    }
  })

  $('nickname').addEventListener('change', () => {
    const value = $('nickname').value.trim()
    void patch({ nickname: value })
  })

  $('theme-seg').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-theme]')
    if (button === null) return
    const preset = button.dataset.theme
    applyTheme(preset)
    void patch({ theme: { preset } })
  })

  $('profile').addEventListener('change', () => {
    const value = $('profile').value
    // 比例变了，像素读数要跟着换基准，但倍数不动
    renderScaleLabel($('scale').value)
    void patch({ profile: value }, { applySize: true })
  })

  // 拖滑杆时只更新数字，松手才保存，避免一路拖一路写盘
  $('scale').addEventListener('input', (event) => {
    renderScaleLabel(event.target.value)
  })
  $('scale').addEventListener('change', (event) => {
    const value = Number(event.target.value)
    void patch({ window: { scale: value } }, { applySize: true })
  })

  $('alwaysOnTop').addEventListener('change', (event) => {
    const value = event.target.checked
    void window.pet.setAlwaysOnTop(value)
    void patch({ window: { alwaysOnTop: value } })
  })

  $('poseEverySeconds').addEventListener('change', (event) => {
    const raw = Number(event.target.value)
    const value = Number.isFinite(raw) ? Math.max(0, Math.min(3600, Math.round(raw))) : 60
    event.target.value = String(value)
    void patch({ poseEverySeconds: value })
  })

  $('edgeSnap').addEventListener('change', (event) => {
    void patch({ window: { edgeSnap: event.target.checked } })
  })

  $('edgeSnapDistance').addEventListener('change', (event) => {
    const raw = Number(event.target.value)
    const value = Number.isFinite(raw) ? Math.max(4, Math.min(64, Math.round(raw))) : 12
    event.target.value = String(value)
    void patch({ window: { edgeSnapDistance: value } })
  })

  // 气泡：模式立即保存，滑杆拖动只改读数、松手才落盘
  $('bubble-mode').addEventListener('change', () => {
    void patch({ bubble: { mode: $('bubble-mode').value } })
  })

  for (const [id, key, digits] of [
    ['bubble-fontSize', 'fontSize', 1],
    ['bubble-width', 'width', 0],
    ['bubble-stickerSize', 'stickerSize', 0],
    ['bubble-radius', 'radius', 0],
    ['bubble-alpha', 'alpha', 2]
  ]) {
    $(id).addEventListener('input', (event) => {
      renderRangeLabel(id, event.target.value, digits)
      if (id.startsWith('bubble-')) renderBubblePreview()
    })
    $(id).addEventListener('change', (event) => {
      void patch({ bubble: { [key]: Number(event.target.value) } })
    })
  }

  // HUD
  $('hudName').addEventListener('change', () => {
    const name = $('hudName').value.trim()
    $('hudName').value = name
    void patch({ hudName: name === '' ? '昔涟' : name })
  })

  $('showHud').addEventListener('change', () => {
    void patch({ showHud: $('showHud').checked })
  })

  $('hudDetail').addEventListener('change', () => {
    void patch({ hudDetail: $('hudDetail').value })
  })

  $('hudAlpha').addEventListener('input', (event) => {
    renderRangeLabel('hudAlpha', event.target.value, 2)
  })
  $('hudAlpha').addEventListener('change', (event) => {
    void patch({ hudAlpha: Number(event.target.value) })
  })

  $('hudScale').addEventListener('input', (event) => {
    renderPercentLabel('hudScale', event.target.value)
  })
  $('hudScale').addEventListener('change', (event) => {
    void patch({ hudScale: Number(event.target.value) })
  })

  $('hudFontScale').addEventListener('input', (event) => {
    renderPercentLabel('hudFontScale', event.target.value)
  })
  $('hudFontScale').addEventListener('change', (event) => {
    void patch({ hudFontScale: Number(event.target.value) })
  })

  // 语音：每项单独存，改触发时机不会顺手把免打扰时段清掉
  $('voice-enabled').addEventListener('change', () => {
    void patch({ voice: { enabled: $('voice-enabled').checked } })
  })

  $('voice-trigger').addEventListener('change', () => {
    void patch({ voice: { trigger: $('voice-trigger').value } })
  })

  $('voice-quiet-enabled').addEventListener('change', () => {
    void patch({ voice: { quietHours: { enabled: $('voice-quiet-enabled').checked } } })
  })

  for (const id of ['voice-quiet-start', 'voice-quiet-end']) {
    $(id).addEventListener('change', () => {
      void patch({
        voice: {
          quietHours: {
            start: $('voice-quiet-start').value,
            end: $('voice-quiet-end').value
          }
        }
      })
    })
  }

  // 本地合成：地址与参考音频也各存各的，互不覆盖。
  $('voice-local-url').addEventListener('change', () => {
    void patch({ voice: { localUrl: $('voice-local-url').value.trim() } })
  })

  $('voice-ref-audio').addEventListener('change', () => {
    void patch({ voice: { refAudioPath: $('voice-ref-audio').value.trim() } })
  })

  // 选择参考音频：主进程只弹框回路径，选中后立刻落盘，取消就保持原值。
  $('voice-ref-audio-pick')?.addEventListener('click', async () => {
    const button = $('voice-ref-audio-pick')
    button.disabled = true
    try {
      const picked = await window.pet.pickRefAudio()
      if (picked?.ok !== true) return
      $('voice-ref-audio').value = picked.path
      void patch({ voice: { refAudioPath: picked.path } })
    } finally {
      button.disabled = false
    }
  })

  // 试听：走和小喇叭同一条合成链路，reason=manual 不受「只在主动搭话时」限制。
  $('voice-preview-btn')?.addEventListener('click', async () => {
    const button = $('voice-preview-btn')
    const text = $('voice-preview-text')?.textContent?.trim() ?? ''
    button.disabled = true
    try {
      const result = await window.pet.speakVoice(text, 'manual')
      if (result?.ok !== true) {
        $('voice-service-note')?.setAttribute('data-preview', 'failed')
      }
    } finally {
      button.disabled = false
    }
  })

  // 连接自检：只把结果写在这一行提示里，不改设置、不写聊天记录。
  $('chat-test-btn')?.addEventListener('click', async () => {
    const button = $('chat-test-btn')
    const hint = $('chat-test-result')
    button.disabled = true
    if (hint !== null) hint.textContent = '…'
    try {
      const result = await window.pet.testLlm()
      if (hint === null) return
      hint.textContent = result?.ok === true
        ? `OK · ${result.model} · ${result.elapsedMs}ms`
        : `FAIL · ${result?.reason ?? 'unknown'}`
    } finally {
      button.disabled = false
    }
  })

  // 同步：导出/应用都走主进程，结果只写在这一行提示里。
  const runSync = async (action) => {
    const button = action === 'export' ? $('sync-export-btn') : $('sync-apply-btn')
    const hint = $('sync-result')
    button.disabled = true
    if (hint !== null) hint.textContent = '…'
    try {
      const result = await window.pet.runSync(action)
      if (hint === null) return
      if (result?.ok !== true) {
        hint.textContent = `FAIL · ${result?.reason ?? 'unknown'}`
        return
      }
      if (action === 'export') {
        hint.textContent = `OK · ${result.count ?? 0}`
      } else {
        hint.textContent = `OK · applied ${result.applied ?? 0}`
        // 对端值已经写回设置，重新读一次让界面跟上。
        await loadSettings()
      }
    } finally {
      button.disabled = false
      void refreshSyncInfo()
    }
  }
  $('sync-export-btn')?.addEventListener('click', () => void runSync('export'))
  $('sync-apply-btn')?.addEventListener('click', () => void runSync('apply'))

  // 同步目录与最近一次导出 / 合并时间：只读展示，换目录交给系统目录选择器。
  const refreshSyncInfo = async () => {
    const pathHint = $('sync-dir-path')
    const exportHint = $('sync-last-export')
    const pullHint = $('sync-last-pull')
    if (typeof window.pet.getSyncInfo !== 'function') return
    try {
      const info = await window.pet.getSyncInfo()
      if (pathHint !== null) {
        pathHint.textContent =
          info?.enabled === true && info.dir !== '' ? info.dir : t('sync.dirUnavailable')
      }
      const exportAt = formatSyncTime(info?.lastExportAt)
      const pullAt = formatSyncTime(info?.lastPullAt)
      if (exportHint !== null) {
        exportHint.textContent =
          exportAt === '' ? t('sync.historyEmpty') : `${t('sync.lastExport')}${exportAt}`
      }
      if (pullHint !== null) {
        pullHint.textContent =
          pullAt === '' ? t('sync.historyEmpty') : `${t('sync.lastPull')}${pullAt}`
      }
    } catch {
      if (pathHint !== null) pathHint.textContent = t('sync.dirUnavailable')
    }
  }

  $('sync-dir-btn')?.addEventListener('click', async () => {
    const button = $('sync-dir-btn')
    if (button === null) return
    button.disabled = true
    try {
      const result = await window.pet.chooseSyncDir()
      if (result?.ok === true) showSaved()
    } finally {
      button.disabled = false
      await refreshSyncInfo()
    }
  })

  void refreshSyncInfo()

  // 同步口令：只用来加密同步包里的敏感字段。状态行只显示是否已设置，不回明文。
  const refreshSyncPassphrase = async () => {
    const status = $('sync-passphrase-status')
    if (status === null) return
    if (typeof window.pet.getSyncPassphraseStatus !== 'function') {
      status.textContent = '当前版本不支持同步口令'
      return
    }
    try {
      const result = await window.pet.getSyncPassphraseStatus()
      if (result?.ok !== true) {
        status.textContent = '加密仓库不可用，暂时读不到口令状态'
        return
      }
      status.textContent = result.configured
        ? `已设置 ${result.masked ?? ''} · 敏感字段只以密文同步`
        : '未设置 · 敏感字段不会进同步包'
    } catch (error) {
      status.textContent = `读取失败：${error instanceof Error ? error.message : String(error)}`
    }
  }

  $('sync-passphrase-save')?.addEventListener('click', async () => {
    const input = $('sync-passphrase')
    const status = $('sync-passphrase-status')
    const button = $('sync-passphrase-save')
    if (input === null) return
    const value = input.value.trim()
    if (!BackupPolicy.isPassphraseLongEnough(value)) {
      if (status !== null) status.textContent = BackupPolicy.passphraseTooShortMessage()
      return
    }
    if (button !== null) button.disabled = true
    if (status !== null) status.textContent = '…'
    try {
      const result = await window.pet.setSyncPassphrase(value)
      if (result?.ok === true) {
        input.value = ''
        if (status !== null) status.textContent = '已保存 · 下次导出会带上密文字段'
        await refreshSyncPassphrase()
      } else if (result?.reason === 'passphrase-too-short') {
        if (status !== null) status.textContent = BackupPolicy.passphraseTooShortMessage()
      } else {
        if (status !== null) status.textContent = '加密仓库不可用，暂时无法保存口令'
      }
    } catch (error) {
      if (status !== null) {
        status.textContent = `保存失败：${error instanceof Error ? error.message : String(error)}`
      }
    } finally {
      if (button !== null) button.disabled = false
    }
  })

  $('sync-passphrase-clear')?.addEventListener('click', async () => {
    const status = $('sync-passphrase-status')
    if (
      !confirmAction({
        message: '清除同步口令后，后续同步包不再带密文字段；已经写出去的旧包仍然需要原口令才能解开。'
      })
    ) {
      return
    }
    try {
      const result = await window.pet.clearSyncPassphrase()
      if (result?.ok !== true) {
        if (status !== null) status.textContent = '清除失败'
        return
      }
      if (status !== null) status.textContent = '已清除 · 后续同步包不再带密文字段'
      await refreshSyncPassphrase()
    } catch (error) {
      if (status !== null) {
        status.textContent = `清除失败：${error instanceof Error ? error.message : String(error)}`
      }
    }
  })

  void refreshSyncPassphrase()

  $('voice-volume').addEventListener('input', (event) => {
    renderRangeLabel('voice-volume', event.target.value, 2)
  })
  $('voice-volume').addEventListener('change', (event) => {
    void patch({ voice: { volume: Number(event.target.value) } })
  })

  $('voice-max-chars').addEventListener('change', () => {
    void patch({ voice: { maxChars: Number($('voice-max-chars').value) } })
  })

  $('voice-min-interval').addEventListener('change', () => {
    void patch({ voice: { minIntervalSeconds: Number($('voice-min-interval').value) } })
  })

  // 语言
  $('locale').addEventListener('change', () => {
    void patch({ locale: $('locale').value })
  })

  // 主动台词：参数即时保存；「试一句」真的请求一次，失败照实显示，不写「已完成」。
  $('presence-ai-enabled').addEventListener('change', () => {
    void patch({ presence: { aiEnabled: $('presence-ai-enabled').checked } })
  })

  $('presence-interval').addEventListener('change', () => {
    void patch({ presence: { intervalMinutes: Number($('presence-interval').value) } })
  })

  $('presence-city').addEventListener('change', () => {
    void patch({ presence: { city: $('presence-city').value.trim() } })
  })

  $('presence-weather').addEventListener('change', () => {
    void patch({ presence: { useWeather: $('presence-weather').checked } })
  })

  // 夜间不扰：开关、时段、方式都即时保存，主进程每 30 秒重新判定一次。
  $('quiet-enabled').addEventListener('change', () => {
    void patch({ presence: { quiet: { enabled: $('quiet-enabled').checked } } })
  })

  const saveQuietWindow = () => {
    void patch({
      presence: {
        quiet: {
          // time 输入被清空时给回默认值，空字符串会让主进程判定成「未开启」。
          from: $('quiet-from').value || '23:00',
          to: $('quiet-to').value || '08:00'
        }
      }
    })
  }
  $('quiet-from').addEventListener('change', saveQuietWindow)
  $('quiet-to').addEventListener('change', saveQuietWindow)

  $('quiet-mode').addEventListener('change', () => {
    void patch({ presence: { quiet: { mode: $('quiet-mode').value } } })
  })

  // HUD 隐藏只写一个小开关；真正是否隐藏由渲染层按当前时间判定。
  $('quiet-hide-hud').addEventListener('change', () => {
    void patch({ presence: { quiet: { hideHud: $('quiet-hide-hud').checked } } })
  })

  const presencePreview = $('presence-preview')
  const presencePreviewOutput = $('presence-preview-output')
  if (presencePreview !== null) {
    presencePreview.addEventListener('click', async () => {
      presencePreview.disabled = true
      if (presencePreviewOutput !== null) presencePreviewOutput.textContent = '正在请求…'
      try {
        const result = await window.pet.speak('preview')
        if (presencePreviewOutput !== null) {
          if (typeof result?.line === 'string' && result.line !== '') {
            // 来源一起写出来：模型写的，还是本地兜底句，一眼能分清。
            presencePreviewOutput.textContent =
              (result.source === 'model' ? '模型：' : '本地兜底：') + result.line
          } else if (result?.reason === 'disabled') {
            presencePreviewOutput.textContent = '先打开上面的「用 AI 生成台词」'
          } else {
            presencePreviewOutput.textContent = `没有拿到台词（${result?.reason ?? 'unknown'}）`
          }
        }
      } catch (error) {
        if (presencePreviewOutput !== null) {
          presencePreviewOutput.textContent = `请求失败：${String(error?.message ?? error)}`
        }
      } finally {
        presencePreview.disabled = false
      }
    })
  }

  // 陪伴任务
  const careBindings = [
    ['care-daily-review-enabled', 'dailyReview', 'enabled', 'checkbox'],
    ['care-daily-review-at', 'dailyReview', 'at', 'text'],
    ['care-case-review-enabled', 'caseReview', 'enabled', 'checkbox'],
    ['care-case-review-at', 'caseReview', 'at', 'text'],
    ['care-questionnaire-enabled', 'questionnaire', 'enabled', 'checkbox'],
    ['care-maslow-enabled', 'maslow', 'enabled', 'checkbox']
  ]

  for (const [id, group, key, kind] of careBindings) {
    $(id).addEventListener('change', () => {
      const value = kind === 'checkbox' ? $(id).checked : $(id).value
      void patch({ companion: { care: { [group]: { [key]: value } } } })
    })
  }

  $('care-budget').addEventListener('change', () => {
    void patch({ companion: { care: { dailyTokenBudget: Number($('care-budget').value) } } })
  })

  // 情绪：半衰期由迁移器夹取，这里只负责把用户输入原样交上去。
  $('emotion-afterglow-enabled').addEventListener('change', () => {
    void patch({
      companion: { emotion: { afterglow: { enabled: $('emotion-afterglow-enabled').checked } } }
    })
  })

  $('emotion-afterglow-half-life').addEventListener('change', () => {
    void patch({
      companion: {
        emotion: { afterglow: { halfLifeMinutes: Number($('emotion-afterglow-half-life').value) } }
      }
    })
  })

  $('emotion-expression-group').addEventListener('change', () => {
    void patch({
      companion: { emotion: { expression: { group: $('emotion-expression-group').value } } }
    })
  })

  $('emotion-needs-enabled').addEventListener('change', () => {
    void patch({ companion: { emotion: { needs: { enabled: $('emotion-needs-enabled').checked } } } })
  })

  // 手动触发巡视与反思：结果只回显真实返回值，不拼一句「已完成」。
  const dailyResult = $('daily-result')
  const dailyRun = $('daily-run')
  if (dailyRun !== null) {
    dailyRun.addEventListener('click', async () => {
      dailyRun.disabled = true
      if (dailyResult !== null) dailyResult.textContent = '正在汇总…'
      try {
        const result = await window.pet.dailyRun()
        if (dailyResult !== null) {
          dailyResult.textContent = result?.ok
            ? `${result.summary}（${result.review?.date ?? '今天'}）`
            : `没有写成：${result?.reason ?? '未知原因'}`
        }
      } catch (error) {
        if (dailyResult !== null) dailyResult.textContent = `调用失败：${String(error?.message ?? error)}`
      } finally {
        dailyRun.disabled = false
      }
    })
  }

  const reflectionRun = $('reflection-run')
  if (reflectionRun !== null) {
    reflectionRun.addEventListener('click', async () => {
      reflectionRun.disabled = true
      if (dailyResult !== null) dailyResult.textContent = '正在整理印象…'
      try {
        const result = await window.pet.reflectionRun()
        if (dailyResult !== null) {
          dailyResult.textContent = result?.ok
            ? `已写入 ${result.filePath}`
            : `没有写成：${result?.reason ?? '未知原因'}`
        }
      } catch (error) {
        if (dailyResult !== null) dailyResult.textContent = `调用失败：${String(error?.error ?? error)}`
      } finally {
        reflectionRun.disabled = false
      }
    })
  }

  // 记忆
  $('memory-enabled').addEventListener('change', () => {
    void patch({ companion: { memory: { enabled: $('memory-enabled').checked } } })
  })

  $('memory-max-items').addEventListener('change', () => {
    void patch({ companion: { memory: { maxItems: Number($('memory-max-items').value) } } })
  })

  $('memory-summarize-every').addEventListener('change', () => {
    void patch({
      companion: { memory: { summarizeEvery: Number($('memory-summarize-every').value) } }
    })
  })

  // 记忆搜索：输入停顿 300ms 再查，命中结果从第一页开始。
  const memorySearch = $('memory-search')
  if (memorySearch !== null) {
    let timer = null
    memorySearch.addEventListener('input', () => {
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(() => {
        memoryQuery = memorySearch.value.trim()
        memoryOffset = 0
        void refreshMemoryList()
      }, 300)
    })
  }

  // 来源与时间筛选：选项一变就从第一页重查；导出沿用同一组条件。
  const memoryRoleSelect = $('memory-role')
  if (memoryRoleSelect !== null) {
    memoryRoleSelect.addEventListener('change', () => {
      memoryRole = memoryRoleSelect.value
      memoryOffset = 0
      void refreshMemoryList()
    })
  }

  const memoryFromInput = $('memory-from')
  if (memoryFromInput !== null) {
    memoryFromInput.addEventListener('change', () => {
      memoryFrom = memoryFromInput.value
      memoryOffset = 0
      void refreshMemoryList()
    })
  }

  const memoryToInput = $('memory-to')
  if (memoryToInput !== null) {
    memoryToInput.addEventListener('change', () => {
      memoryTo = memoryToInput.value
      memoryOffset = 0
      void refreshMemoryList()
    })
  }

  const memoryExport = $('memory-export')
  if (memoryExport !== null) {
    memoryExport.addEventListener('click', () => {
      void exportMemory()
    })
  }

  // 记忆列表：刷新、翻页、单条删除。
  const memoryRefresh = $('memory-refresh')
  if (memoryRefresh !== null) {
    memoryRefresh.addEventListener('click', () => {
      void refreshMemoryStats()
      void refreshMemoryList()
    })
  }

  const memoryPrev = $('memory-prev')
  if (memoryPrev !== null) {
    memoryPrev.addEventListener('click', () => {
      memoryOffset = Math.max(0, memoryOffset - MEMORY_PAGE_SIZE)
      void refreshMemoryList()
    })
  }

  const memoryNext = $('memory-next')
  if (memoryNext !== null) {
    memoryNext.addEventListener('click', () => {
      if (memoryOffset + MEMORY_PAGE_SIZE < memoryTotal) {
        memoryOffset += MEMORY_PAGE_SIZE
        void refreshMemoryList()
      }
    })
  }

  // 启动前体检：手动重跑一次，结果覆盖旧值。
  const preflightRefresh = $('preflight-refresh')
  if (preflightRefresh !== null) {
    preflightRefresh.addEventListener('click', () => {
      void refreshPreflight()
    })
  }

  // 聊天
  $('chat-enabled').addEventListener('change', () => {
    void patch({ companion: { chat: { enabled: $('chat-enabled').checked } } })
  })

  $('chat-model').addEventListener('change', () => {
    void patch({ companion: { chat: { model: $('chat-model').value } } })
  })

  $('chat-max-tokens').addEventListener('change', () => {
    void patch({ companion: { chat: { maxTokens: Number($('chat-max-tokens').value) } } })
  })

  $('chat-temperature').addEventListener('input', (event) => {
    renderRangeLabel('chat-temperature', event.target.value, 1)
  })
  $('chat-temperature').addEventListener('change', (event) => {
    void patch({ companion: { chat: { temperature: Number(event.target.value) } } })
  })

  $('chat-history-limit').addEventListener('change', () => {
    void patch({
      companion: { chat: { historyLimit: Number($('chat-history-limit').value) } }
    })
  })

  // 人格
  $('persona-enabled').addEventListener('change', () => {
    void patch({ companion: { persona: { enabled: $('persona-enabled').checked } } })
    void renderPersonaPreview()
  })

  $('persona-extra').addEventListener('input', () => {
    updatePersonaCount()
  })

  $('persona-extra').addEventListener('change', () => {
    void patch({ companion: { persona: { extraPrompt: $('persona-extra').value } } })
    void renderPersonaPreview()
  })

  // 模块开关。写进 settings.modules，主窗口下次启动按它决定是否 bootstrap；
  // 气泡的显隐由主窗口监听 settings 变更即时处理。
  for (const [boxId, moduleId] of Object.entries({
    'module-bubble': 'builtin.bubble',
    'module-reminder': 'builtin.reminder',
    'module-balance': 'builtin.balance'
  })) {
    $(boxId).addEventListener('change', (event) => {
      void patch({ modules: { [moduleId]: { enabled: event.target.checked } } })
    })
  }

  // 能力中心：窗口由主进程单例管理，这里只负责把请求发出去。
  $('open-ability-center').addEventListener('click', async () => {
    try {
      await window.pet.openAbilityCenter()
    } catch (error) {
      window.alert(`打开能力中心失败：${error instanceof Error ? error.message : String(error)}`)
    }
  })

  // 游戏日常：检测与演练预览都走主进程，渲染层只收集表单。
  // 真实执行没有开放，所以表单固定 mode: 'dry'，不提供 real 选项。
  let gameDetected = null

  function renderGameDetected() {
    if (gameDetected === null) return

    const bettergi = gameDetected.bettergi?.path ?? null
    const bettergiEl = $('game-bettergi-status')
    bettergiEl.textContent = bettergi === null ? '未找到 BetterGI.exe' : `已找到 · ${bettergi}`
    bettergiEl.title = bettergi ?? ''

    const gamePath = gameDetected.games?.[$('game-select').value]?.path ?? null
    const pathEl = $('game-path-status')
    pathEl.textContent = gamePath === null ? '未找到游戏本体' : `已找到 · ${gamePath}`
    pathEl.title = gamePath ?? ''
  }

  function fillGameForm(config) {
    $('game-select').value = config.game ?? 'genshin'
    $('game-time').value = config.time ?? '04:00'
    $('game-timeout').value = String(config.timeoutMinutes ?? 150)

    const days = new Set(config.days ?? [])
    for (const box of document.querySelectorAll('.game-day')) {
      box.checked = days.has(Number(box.value))
    }
    renderGameDetected()
  }

  function readGameForm() {
    const days = []
    for (const box of document.querySelectorAll('.game-day')) {
      if (box.checked) days.push(Number(box.value))
    }

    return {
      game: $('game-select').value,
      time: $('game-time').value,
      days,
      timeoutMinutes: Number($('game-timeout').value),
      mode: 'dry',
      enabled: false
    }
  }

  function renderGameResult(result) {
    const lines = []
    if (result?.ok !== true) {
      lines.push('排班还不能预览：')
      for (const issue of result?.issues ?? []) lines.push(`· ${issue.message}`)
    } else {
      lines.push(result.preview)
      lines.push(`下次：${result.nextRunLabel}`)
      const dependencies = result.dependencies
      lines.push(
        `环境：${dependencies?.canRun === true ? '真实执行所需项已齐' : '真实执行还差一些项'}`
      )
      for (const item of dependencies?.items ?? []) {
        const detail = item.detail === undefined ? '' : ` · ${item.detail}`
        lines.push(`· ${item.label}：${item.status}${detail}`)
      }
      lines.push(result.risk)
    }
    $('game-preview').textContent = lines.join('\n')
  }

  async function refreshGameDaily() {
    if (typeof window.pet?.gameScheduleGet !== 'function') return
    try {
      const result = await window.pet.gameScheduleGet()
      fillGameForm(result?.config ?? {})
      if (result?.error !== null && result?.error !== undefined) {
        $('game-preview').textContent = `配置读取失败（${result.error}），已用默认值。`
      }
    } catch (error) {
      $('game-preview').textContent = `配置读取失败：${error instanceof Error ? error.message : String(error)}`
    }
  }

  $('game-detect').addEventListener('click', async () => {
    if (typeof window.pet?.gameDetect !== 'function') return
    try {
      gameDetected = await window.pet.gameDetect()
      renderGameDetected()
      $('game-preview').textContent = '检测完成。可以保存排班，或直接做一次演练预览。'
    } catch (error) {
      $('game-preview').textContent = `检测失败：${error instanceof Error ? error.message : String(error)}`
    }
  })

  $('game-select').addEventListener('change', renderGameDetected)

  $('game-save').addEventListener('click', async () => {
    if (typeof window.pet?.gameScheduleSave !== 'function') return
    try {
      const result = await window.pet.gameScheduleSave(readGameForm())
      if (result?.ok === true) {
        $('game-preview').textContent = '排班已保存。模式仍是演练，真实执行没有开放。'
        showSaved()
      } else {
        renderGameResult(result)
      }
    } catch (error) {
      $('game-preview').textContent = `保存失败：${error instanceof Error ? error.message : String(error)}`
    }
  })

  $('game-dry-run').addEventListener('click', async () => {
    if (typeof window.pet?.gameDryRun !== 'function') return
    try {
      renderGameResult(await window.pet.gameDryRun(readGameForm()))
    } catch (error) {
      $('game-preview').textContent = `预览失败：${error instanceof Error ? error.message : String(error)}`
    }
  })

  void refreshGameDaily()
  void refreshQqStatus()
  // 状态只在主进程真实变化后更新，轮询只读，不会触发重连。
  setInterval(() => {
    if (!document.hidden) void refreshQqStatus()
  }, 5000)

  // QQ：改一项存一项，失焦/切换即落盘；密钥单独走 Vault。
  const qqBusy = (button, busy) => {
    if (button === null || button === undefined) return
    button.setAttribute('aria-disabled', busy ? 'true' : 'false')
  }
  const qqIsBusy = (button) =>
    button !== null && button !== undefined && button.getAttribute('aria-disabled') === 'true'

  function renderQqRuntime(info) {
    const stateNode = $('qq-runtime-state')
    const detailNode = $('qq-runtime-detail')
    if (stateNode === null || detailNode === null) return
    if (info === null || info === undefined || info.enabled !== true) {
      stateNode.dataset.tone = 'off'
      stateNode.textContent = t('qq.runtimeOff')
      detailNode.textContent = info?.reason || t('qq.enabledHint')
      return
    }
    const labels = {
      starting: t('qq.runtimeStarting'),
      ready: t('qq.runtimeReady'),
      error: t('qq.runtimeError'),
      off: t('qq.runtimeOff')
    }
    stateNode.dataset.tone = info.state === 'ready' ? 'ok' : info.state === 'error' ? 'error' : 'off'
    stateNode.textContent = labels[info.state] ?? t('qq.runtimeOff')
    const parts = []
    if (typeof info.reason === 'string' && info.reason !== '') parts.push(info.reason)
    if (Number(info.queued) > 0) {
      parts.push(t('qq.runtimeQueued').replace('{count}', String(info.queued)))
    }
    if (info.transport === 'webhook') {
      const port = info.webhook?.port
      if (info.webhook?.listening === true) {
        parts.push(t('qq.runtimeWebhook').replace('{port}', String(port ?? '—')))
      } else if (info.webhook?.error) {
        parts.push(t('qq.runtimeWebhookFailed'))
      }
    }
    detailNode.textContent = parts.length === 0 ? '—' : parts.join(' · ')
  }

  async function refreshQqStatus() {
    if (typeof window.pet?.qqStatus !== 'function') return
    try {
      renderQqRuntime(await window.pet.qqStatus())
    } catch {
      renderQqRuntime({ enabled: true, state: 'error', reason: t('qq.runtimeError') })
    }
  }

  // 主进程重建通道有 400ms 防抖；稍后再读一次，避免立刻读到旧状态。
  const refreshQqStatusSoon = () => {
    setTimeout(() => void refreshQqStatus(), 600)
  }

  const saveQq = async (fields) => {
    await patch({ channels: { qq: fields } })
    refreshQqStatusSoon()
  }
  $('qq-enabled')?.addEventListener('change', (event) => {
    void saveQq({ enabled: event.target.checked === true })
  })
  $('qq-transport')?.addEventListener('change', (event) => {
    updateQqTransportVisibility()
    void saveQq({ transport: event.target.value === 'webhook' ? 'webhook' : 'gateway' })
  })
  $('qq-app-id')?.addEventListener('change', (event) => {
    void saveQq({ appId: String(event.target.value ?? '').trim() })
  })
  $('qq-owners')?.addEventListener('change', () => {
    void saveQq({ ownerOpenIds: readQqOwners() })
  })
  $('qq-target')?.addEventListener('change', (event) => {
    void saveQq({ targetOpenId: String(event.target.value ?? '').trim() })
  })
  $('qq-public-key')?.addEventListener('change', (event) => {
    void saveQq({ publicKey: String(event.target.value ?? '').trim() })
  })
  $('qq-port')?.addEventListener('change', (event) => {
    const port = Number(event.target.value)
    const safe = Number.isInteger(port) && port >= 1 && port <= 65535 ? port : 8787
    event.target.value = String(safe)
    void saveQq({ webhookPort: safe })
  })

  $('qq-secret-save')?.addEventListener('click', async () => {
    const input = $('qq-secret')
    const value = String(input?.value ?? '').trim()
    if (value === '') {
      input?.focus()
      return
    }
    const button = $('qq-secret-save')
    if (qqIsBusy(button)) return
    qqBusy(button, true)
    try {
      await window.pet.setSecret(QQ_SECRET_SERVICE, value, QQ_SECRET_FIELD)
      input.value = ''
      await refreshQqMask()
      refreshQqStatusSoon()
      showSaved()
    } catch (error) {
      $('qq-secret-mask').textContent = `保存失败：${error instanceof Error ? error.message : String(error)}`
    } finally {
      qqBusy(button, false)
    }
  })

  $('qq-secret-clear')?.addEventListener('click', async () => {
    const button = $('qq-secret-clear')
    if (qqIsBusy(button)) return
    qqBusy(button, true)
    try {
      await window.pet.clearSecret(QQ_SECRET_SERVICE, QQ_SECRET_FIELD)
      $('qq-secret').value = ''
      await refreshQqMask()
      refreshQqStatusSoon()
      showSaved()
    } catch (error) {
      $('qq-secret-mask').textContent = `清除失败：${error instanceof Error ? error.message : String(error)}`
    } finally {
      qqBusy(button, false)
    }
  })

  $('qq-test')?.addEventListener('click', async () => {
    if (typeof window.pet?.qqTest !== 'function') return
    const button = $('qq-test')
    const result = $('qq-test-result')
    if (button === null || result === null) return
    if (qqIsBusy(button)) return
    qqBusy(button, true)
    result.textContent = '测试中…'
    try {
      const payload = await window.pet.qqTest()
      if (payload?.ok === true) {
        result.textContent = `网关可达 ${payload.gatewayHost || ''}`.trim()
      } else {
        const reason = payload?.reason ?? 'unknown'
        result.textContent =
          reason === 'missing-app-id'
            ? '缺少 AppID'
            : reason === 'missing-secret'
              ? '缺少 AppSecret'
              : `失败：${payload?.message ?? reason}`
      }
    } catch (error) {
      result.textContent = `失败：${error instanceof Error ? error.message : String(error)}`
    } finally {
      qqBusy(button, false)
      refreshQqStatusSoon()
    }
  })

  // DeepSeek 密钥：保存后立刻清空输入框，界面只留掩码。
  // 明文只在这一次 IPC 里出现，之后主进程也不回传。
  $('deepseek-save').addEventListener('click', async () => {
    const input = $('deepseek-key')
    const value = input.value.trim()
    if (value === '') {
      input.focus()
      return
    }

    const button = $('deepseek-save')
    button.disabled = true
    try {
      await window.pet.setSecret(DEEPSEEK_SERVICE, value, DEEPSEEK_FIELD)
      input.value = ''
      clearPending('deepseek-key')
      await refreshDeepSeekMask()
      showSaved()
    } catch (error) {
      $('deepseek-mask').textContent = `保存失败：${error instanceof Error ? error.message : String(error)}`
    } finally {
      button.disabled = false
    }
  })

  $('balance-check')?.addEventListener('click', async () => {
    const button = $('balance-check')
    const result = $('balance-result')
    if (button === null || result === null) return
    button.disabled = true
    result.textContent = '…'
    try {
      const info = await window.pet.queryBalance()
      if (info?.ok === true) {
        const total = Number(info.totalBalance)
        const spent = Number(info.todaySpent)
        const parts = [Number.isFinite(total) ? `¥${total.toFixed(2)}` : '—']
        if (Number.isFinite(spent)) {
          parts.push(`${t('connection.balanceToday')} ≈¥${spent.toFixed(2)}`)
        }
        result.textContent = parts.join(' · ')
      } else if (info?.reason === 'no-key') {
        result.textContent = t('connection.balanceNoKey')
      } else {
        result.textContent = `${t('connection.balanceFailed')}（${String(info?.reason ?? 'unknown')}）`
      }
    } catch {
      result.textContent = t('connection.balanceFailed')
    } finally {
      button.disabled = false
    }
  })

  $('deepseek-clear').addEventListener('click', async () => {
    if (
      !confirmAction({
        message:
          '清除后本机不再保存这把 Key：余额查询、聊天、主动台词与云端语音合成会立刻停用，余额状态显示为未配置；本地音色、提醒与巡视汇总不受影响。DeepSeek 账户本身不受影响，重新粘贴即可恢复。'
      })
    ) {
      return
    }
    const button = $('deepseek-clear')
    button.disabled = true
    try {
      await window.pet.clearSecret(DEEPSEEK_SERVICE, DEEPSEEK_FIELD)
      $('deepseek-key').value = ''
      await refreshDeepSeekMask()
      showSaved()
    } catch (error) {
      $('deepseek-mask').textContent = `清除失败：${error instanceof Error ? error.message : String(error)}`
    } finally {
      button.disabled = false
    }
  })

  // 一键备份：目录、保留份数与自动节奏存在主进程的小配置里；
  // 自动备份口令由主进程用系统密钥加密保存，渲染侧始终拿不到明文。
  async function refreshBackupConfig() {
    const hint = $('backup-dir-hint')
    const keepInput = $('backup-keep')
    const status = $('backup-status')
    const autoEnabled = $('backup-auto-enabled')
    const autoDays = $('backup-auto-days')
    const autoStatus = $('backup-auto-status')
    const latestHint = $('backup-latest-hint')
    try {
      const config = await window.pet.backupConfig()
      if (hint !== null) {
        hint.textContent =
          typeof config?.dirName === 'string' && config.dirName !== ''
            ? `${t('backup.dirChosen')}：${config.dirName}`
            : `${t('backup.dirFallback')}：${config?.fallbackDirName ?? ''}`
      }
      if (keepInput !== null && Number.isInteger(config?.keep)) {
        keepInput.value = String(config.keep)
      }
      if (status !== null && typeof config?.lastRunAt === 'string' && config.lastRunAt !== '') {
        status.textContent = `${t('backup.lastRun')}：${new Date(config.lastRunAt).toLocaleString()}`
      }

      const intervalDays = Number.isInteger(config?.autoIntervalDays) ? config.autoIntervalDays : 0
      if (autoEnabled !== null) autoEnabled.checked = intervalDays > 0
      if (autoDays !== null) autoDays.value = String(intervalDays > 0 ? intervalDays : 7)
      if (autoStatus !== null) {
        if (intervalDays <= 0) {
          autoStatus.textContent = t('backup.autoOff')
        } else if (typeof config?.autoLastError === 'string' && config.autoLastError !== '') {
          autoStatus.textContent = `${t('backup.autoError')}：${config.autoLastError}`
        } else if (typeof config?.lastRunAt === 'string' && config.lastRunAt !== '') {
          autoStatus.textContent = `${t('backup.autoOn')}：${new Date(config.lastRunAt).toLocaleString()}`
        } else {
          autoStatus.textContent = t('backup.autoOn')
        }
      }

      if (latestHint !== null) {
        try {
          const latest = await window.pet.backupFindLatest()
          latestHint.textContent =
            latest?.found === true
              ? `${latest.fileName} · ${new Date(latest.mtime).toLocaleString()} · ${latest.path}`
              : `${t('backup.latestNone')}（${latest?.dir ?? ''}）`
        } catch {
          // 扫描失败时保留默认文案，不影响其它设置。
        }
      }
    } catch {
      // 读不到配置就保持默认文案，不影响手动备份。
    }
  }

  $('backup-choose-dir')?.addEventListener('click', async () => {
    const result = await window.pet.backupChooseDir()
    if (result?.ok === true) await refreshBackupConfig()
  })

  $('backup-keep')?.addEventListener('change', async () => {
    const input = $('backup-keep')
    const status = $('backup-status')
    const result = await window.pet.backupSetKeep(Number(input?.value))
    if (result?.ok !== true && status !== null) {
      status.textContent = result?.message ?? t('backup.keepInvalid')
    }
  })

  $('backup-auto-enabled')?.addEventListener('change', async (event) => {
    const checkbox = event.target
    const daysInput = $('backup-auto-days')
    const autoStatus = $('backup-auto-status')
    const passwordInput = $('backup-password')
    const enabled = checkbox?.checked === true
    const days = Math.max(1, Math.min(365, Number(daysInput?.value) || 7))
    const password = typeof passwordInput?.value === 'string' ? passwordInput.value : ''
    if (checkbox !== null) checkbox.disabled = true
    try {
      const result = await window.pet.backupSetAuto(enabled ? days : 0, password)
      if (result?.ok !== true) {
        if (checkbox !== null) checkbox.checked = false
        if (autoStatus !== null) {
          autoStatus.textContent =
            result?.reason === 'need-password'
              ? t('backup.autoNeedPassword')
              : (result?.message ?? t('backup.autoFailed'))
        }
        return
      }
      await refreshBackupConfig()
    } finally {
      if (checkbox !== null) checkbox.disabled = false
    }
  })

  $('backup-auto-days')?.addEventListener('change', () => {
    const checkbox = $('backup-auto-enabled')
    if (checkbox?.checked !== true) return
    checkbox.dispatchEvent(new Event('change'))
  })

  $('backup-run')?.addEventListener('click', async () => {
    const input = $('backup-password')
    const status = $('backup-status')
    const password = input?.value ?? ''
    if (!BackupPolicy.isPassphraseLongEnough(password)) {
      status.textContent = BackupPolicy.passphraseTooShortMessage()
      return
    }
    const advice = BackupPolicy.passphraseAdvice(password)
    if (
      !confirmAction({
        message: `${advice}备份会落到选定目录，并只保留最近几份。确定开始吗？`
      })
    ) {
      return
    }

    status.textContent = '正在备份…'
    try {
      const result = await window.pet.backupRun(password)
      if (result?.ok !== true) {
        status.textContent = `备份失败：${result?.message ?? result?.reason ?? '未知原因'}`
        return
      }
      const removed = Number(result.removed) || 0
      status.textContent =
        `已备份 ${result.fileName}` + (removed > 0 ? `，清理了 ${removed} 份旧备份` : '')
    } catch (error) {
      status.textContent = `备份失败：${error instanceof Error ? error.message : String(error)}`
    } finally {
      if (input) input.value = ''
    }
  })

  void refreshBackupConfig()

  // 加密备份：口令只在这次调用里出现，不写进设置，也不做本地缓存。
  $('backup-export')?.addEventListener('click', async () => {
    const input = $('backup-password')
    const status = $('backup-status')
    const password = input?.value ?? ''
    if (!BackupPolicy.isPassphraseLongEnough(password)) {
      status.textContent = BackupPolicy.passphraseTooShortMessage()
      return
    }
    const advice = BackupPolicy.passphraseAdvice(password)
    if (
      !confirmAction({
        message: `${advice}口令丢失后无法找回，也没有重置入口。确定继续导出吗？`
      })
    ) {
      return
    }

    status.textContent = '正在导出…'
    try {
      const result = await window.pet.vaultExport(password)
      if (result?.ok !== true) {
        status.textContent =
          result?.reason === 'canceled'
            ? '已取消'
            : `导出失败：${result?.message ?? result?.reason ?? '未知原因'}`
        return
      }
      status.textContent = `已导出 ${result.fileCount ?? 0} 个文件`
    } catch (error) {
      status.textContent = `导出失败：${error instanceof Error ? error.message : String(error)}`
    } finally {
      if (input) input.value = ''
    }
  })

  $('backup-import')?.addEventListener('click', async () => {
    const input = $('backup-password')
    const status = $('backup-status')
    const password = input?.value ?? ''
    if (!BackupPolicy.isPassphraseLongEnough(password)) {
      status.textContent = BackupPolicy.passphraseTooShortMessage()
      return
    }
    if (
      !confirmAction({
        message: '导入会覆盖本机现有的密钥与记忆，并需要重启；口令必须与导出时一致。',
        strength: 'danger',
        confirmWord: '导入'
      })
    ) {
      return
    }

    status.textContent = '正在导入…'
    try {
      const result = await window.pet.vaultImport(password)
      if (result?.ok !== true) {
        status.textContent =
          result?.reason === 'canceled'
            ? '已取消'
            : `导入失败：${result?.message ?? result?.reason ?? '未知原因'}`
        return
      }
      status.textContent = result.restartRequired === true ? '导入完成，正在重启…' : '导入完成'
    } catch (error) {
      status.textContent = `导入失败：${error instanceof Error ? error.message : String(error)}`
    } finally {
      if (input) input.value = ''
    }
  })

  // 轮换密钥：只影响之后的写入；旧记忆靠原 keyId 继续读，不会丢。
  $('backup-rotate')?.addEventListener('click', async () => {
    const button = $('backup-rotate')
    const status = $('rotate-status')
    if (
      !confirmAction({
        message:
          '会换一把新的数据密钥用于之后的写入。已有记忆和聊天历史仍能读，但用旧密钥导出的备份将无法再与当前数据合并。请先导出一次备份再操作。',
        strength: 'danger',
        confirmWord: '轮换'
      })
    ) {
      return
    }

    button.disabled = true
    status.textContent = '正在轮换…'
    try {
      const result = await window.pet.vaultRotate()
      if (result?.ok !== true) {
        status.textContent = `轮换失败：${result?.message ?? result?.reason ?? '未知原因'}`
        return
      }
      status.textContent = `已轮换：epoch ${result.from} → ${result.to}`
    } catch (error) {
      status.textContent = `轮换失败：${error instanceof Error ? error.message : String(error)}`
    } finally {
      button.disabled = false
    }
  })

  // 填写未提交：只标记真正需要按按钮才生效的输入
  for (const id of ['deepseek-key', 'backup-password']) {
    $(id)?.addEventListener('input', (event) => {
      if (String(event.target.value ?? '').trim() === '') clearPending(id)
      else markPending(id)
    })
  }

  $('close-btn').addEventListener('click', () => {
    if (
      pendingInputs.size > 0 &&
      !confirmAction({ message: '还有填写未提交，关窗后需要重新输入。确定关闭吗？' })
    ) {
      return
    }
    void window.pet.closeSettings()
  })

  // 搜索：输入即过滤，清空即恢复完整列表
  $('settings-search').addEventListener('input', (event) => {
    runSearch(event.target.value)
  })

  injectSectionResets()

  // 分组恢复默认：按钮自己声明恢复哪几个顶层键
  for (const button of document.querySelectorAll('.section-reset')) {
    button.addEventListener('click', () => {
      void resetSection(button)
    })
  }

  $('defaults-reset-all')?.addEventListener('click', () => {
    void resetAllSettings()
  })

  // Esc 先清搜索、再关窗；Ctrl/Cmd+F 聚焦搜索
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      const search = $('settings-search')
      if (search !== null && search.value !== '') {
        search.value = ''
        clearSearchFilter()
        search.blur()
        return
      }
      void window.pet.closeSettings()
      return
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
      event.preventDefault()
      $('settings-search')?.focus()
    }
  })

  // 设置窗保持打开时，主窗口改了尺寸要能反映最新值
  window.addEventListener('focus', () => {
    void refreshDiagnostics()
  })
}

// 主进程只回 state，人话统一走 reason-text.js；这里不再维护第二份映射。
function describeVoiceState(status) {
  const key = window.CyreneReasonText.voiceKey(status?.state)
  return key === null ? t('voice.state.unknown') : t(key)
}

// 密钥环状态给的是「现在能不能读到旧数据」，不是安全评级；措辞不做美化。
function describeKeyRingState(diagnostic) {
  if (diagnostic?.ok === false) return '不可用'
  // 迁移失败时明文可能还留在 settings.json，这条比密钥环状态更需要先看到。
  if (diagnostic?.legacyKeyMigration !== null && diagnostic?.legacyKeyMigration !== undefined) {
    return '⚠️ 明文密钥未迁移 · settings.json 里可能仍有 LLM Key'
  }
  const ring = diagnostic?.keyRingState
  if (ring === 'quarantined') return '已隔离重建 · 旧数据可能打不开'
  if (ring === 'rebuilt') return '已重建 · 旧数据可能打不开'
  const signer = diagnostic?.signerState === 'unavailable' ? ' · 签名不可用' : ''
  return `正常（${diagnostic?.backend ?? '未知后端'}）${signer}`
}

async function refreshDiagnostics() {
  try {
    const info = await window.pet.diagnostics()
    $('diag-version').textContent = `${info.app?.version ?? '—'}（Electron ${info.app?.electron ?? '—'}）`

    const size = await window.pet.getWindowSize()
    $('diag-size').textContent = size === null ? '—' : `${size.width} × ${size.height}`

    const media = await window.pet.getRenderInfo()
    $('diag-media').textContent = media.media ?? '未加载'
    $('diag-frames').textContent = String(media.frames ?? '—')
    $('diag-hit').textContent = String(media.hit ?? '—')

    const settingsNow = await window.pet.getSettings()
    const modules = Object.entries(settingsNow.modules ?? {})
    $('diag-modules').textContent =
      modules.length === 0
        ? '未配置'
        : modules
            .map(([name, toggle]) => `${name.replace('builtin.', '')}=${toggle.enabled ? 'on' : 'off'}`)
            .join(' · ')

    const voiceNote = $('diag-voice')
    if (typeof window.pet.voiceStatus === 'function') {
      const status = await window.pet.voiceStatus()
      const text = describeVoiceState(status)
      voiceNote.textContent = text
      // 语音面板底部也显示同一份真实状态，不必切到「运行状态」才看得到。
      const panelNote = $('voice-service-note')
      if (panelNote !== null) panelNote.textContent = `${t('voice.statusLabel')}：${text}`
    } else {
      voiceNote.textContent = t('voice.state.unknown')
    }

    // 密钥环状态决定「换机/密钥丢失后旧数据还能不能读」，比备份按钮更需要先看到。
    const keyringNote = $('backup-keyring')
    if (keyringNote !== null && typeof window.pet.vaultDiagnose === 'function') {
      keyringNote.textContent = describeKeyRingState(await window.pet.vaultDiagnose())
    }
  } catch (error) {
    console.error('[settings] 诊断读取失败', error)
  }
}

/**
 * 素材包：导入 / 列出 / 删除，以及把包内文件填进四个来源选择器。
 * 清单来自主进程；这里只负责显示和把选择写回 settings，不拼绝对路径。
 */
let packs = []

/** 把当前包的某一类文件填进 select；当前值失效时保留一条可见的坏引用。 */
function fillPackSelect(select, kind, currentValue, emptyLabel) {
  if (select === null) return
  select.textContent = ''

  const empty = document.createElement('option')
  empty.value = ''
  empty.textContent = emptyLabel
  select.append(empty)

  const seen = new Set()
  for (const pack of packs.filter((entry) => entry.enabled !== false)) {
    for (const item of pack.files?.[kind] ?? []) {
      const value = `pack:${pack.id}:${item.file}`
      if (seen.has(value)) continue
      seen.add(value)
      const option = document.createElement('option')
      option.value = value
      option.textContent = `${pack.name || pack.id} · ${item.name}`
      select.append(option)
    }
  }

  if (currentValue !== '' && !seen.has(currentValue)) {
    const stale = document.createElement('option')
    stale.value = currentValue
    stale.textContent = `${t('packs.stale')}：${currentValue}`
    select.append(stale)
  }
  select.value = currentValue
}

/** 重填所有来源选择器。settings 里存的是 pack:<id>:<file>，不存真实路径。 */
function renderPackSelectors() {
  const bubble = current?.bubble ?? {}
  const icon = current?.icon ?? {}
  const sticker = current?.sticker ?? {}

  fillPackSelect($('icon-tray'), 'icon', icon.tray ?? '', '内置 Cyrene 托盘图标')
  fillPackSelect($('icon-app'), 'icon', icon.app ?? '', '内置 Cyrene 图标')
  fillPackSelect($('bubble-background'), 'bubble', bubble.background ?? '', '不用底图（纯色气泡）')
  fillPackSelect($('bubble-font'), 'font', bubble.fontFamily ?? '', '内置字体栈')
  fillPackSelect($('sticker-source'), 'emoji', sticker.source ?? '', '不显示贴纸')
  renderStickerGrid()

  const slice = $('bubble-slice')
  if (slice !== null) slice.value = String(bubble.backgroundSlice ?? 12)
}

/**
 * 贴纸缩略图墙：只画当前启用包里真实存在的表情文件。
 * 选中值仍写 pack:<id>:<file>，和下拉框共用同一条写入路径。
 */
function renderStickerGrid() {
  const grid = $('sticker-grid')
  const select = $('sticker-source')
  if (grid === null || select === null) return
  grid.replaceChildren()

  const items = []
  for (const pack of packs.filter((entry) => entry.enabled !== false)) {
    for (const item of pack.files?.emoji ?? []) {
      items.push({
        value: `pack:${pack.id}:${item.file}`,
        url: item.url,
        name: `${pack.name || pack.id} · ${item.name}`
      })
    }
  }

  if (items.length === 0) {
    const empty = document.createElement('p')
    empty.className = 'section-note'
    empty.textContent = t('packs.stickerEmpty')
    grid.append(empty)
    return
  }

  const none = document.createElement('button')
  none.type = 'button'
  none.className = 'asset-tile asset-tile-none'
  none.dataset.value = ''
  none.textContent = t('packs.stickerNone')
  none.addEventListener('click', () => pickSticker(''))
  grid.append(none)

  for (const item of items) {
    const tile = document.createElement('button')
    tile.type = 'button'
    tile.className = 'asset-tile'
    tile.dataset.value = item.value
    tile.title = item.name

    const image = document.createElement('img')
    image.src = item.url
    image.alt = item.name
    image.loading = 'lazy'

    const label = document.createElement('span')
    label.textContent = item.name

    tile.append(image, label)
    tile.addEventListener('click', () => pickSticker(item.value))
    grid.append(tile)
  }

  syncStickerGridActive()
}

/** 高亮当前贴纸；以 select 的值为准，点击后立刻能看到反馈。 */
function syncStickerGridActive() {
  const grid = $('sticker-grid')
  const select = $('sticker-source')
  if (grid === null || select === null) return
  for (const tile of grid.querySelectorAll('.asset-tile')) {
    tile.classList.toggle('is-active', tile.dataset.value === select.value)
  }
}

function pickSticker(value) {
  const select = $('sticker-source')
  if (select === null) return
  select.value = value
  syncStickerGridActive()
  select.dispatchEvent(new Event('change'))
}

function formatPackCounts(counts = {}) {
  const parts = []
  if (counts.icon > 0) parts.push(`图标 ${counts.icon}`)
  if (counts.font > 0) parts.push(`字体 ${counts.font}`)
  if (counts.bubble > 0) parts.push(`气泡 ${counts.bubble}`)
  if (counts.emoji > 0) parts.push(`表情 ${counts.emoji}`)
  return parts.join('，')
}

function renderPackList() {
  const box = $('pack-list')
  if (box === null) return
  box.textContent = ''

  if (packs.length === 0) {
    box.textContent = t('packs.empty')
    return
  }

  const groups = [
    {
      key: 'builtin',
      label: t('packs.sourceBuiltin'),
      items: packs.filter((pack) => pack.source === 'builtin')
    },
    {
      key: 'imported',
      label: t('packs.sourceImported'),
      items: packs.filter((pack) => pack.source !== 'builtin')
    }
  ]

  const builtinCount = groups[0].items.length
  const importedCount = groups[1].items.length
  const brokenCount = packs.filter((pack) => pack.broken === true).length

  for (const group of groups) {
    if (group.items.length === 0) continue

    const heading = document.createElement('div')
    heading.className = 'pack-group'
    heading.textContent = group.label
    box.append(heading)

    for (const pack of group.items) {
      const isBuiltin = pack.source === 'builtin'
      const row = document.createElement('div')
      row.className = 'pack-row'

      const enabled = pack.enabled !== false
      const broken = pack.broken === true
      const text = document.createElement('div')
      text.className = 'pack-text'

      const nameRow = document.createElement('div')
      nameRow.className = 'pack-name-row'

      const name = document.createElement('div')
      name.className = 'pack-name'
      name.textContent = pack.name || pack.id

      const badge = document.createElement('span')
      badge.className = `pack-badge${broken ? ' is-broken' : enabled ? '' : ' is-disabled'}`
      badge.textContent = broken
        ? t('packs.statusBroken')
        : enabled ? t('packs.statusOk') : t('packs.statusDisabled')
      nameRow.append(name, badge)

      const meta = document.createElement('div')
      meta.className = 'pack-meta'
      const summary = formatPackCounts(pack.counts ?? {})
      const source = pack.metaSource === 'guessed' ? t('packs.metaGuessed') : 'pack.json'
      const size = pack.bytes > 0 ? ` · ${formatBytes(pack.bytes)}` : ''
      const detail = broken
        ? [t('packs.noKinds'), pack.manifestError ?? ''].filter((part) => part !== '').join(' · ')
        : summary === '' ? t('packs.noKinds') : summary
      meta.textContent = `${source} · ${detail}${size}`

      // 第一张能显示的素材当缩略图；没有就留空，不塞占位图。
      const thumb = pack.emoji ?? pack.icon ?? pack.bubble ?? null
      if (thumb?.url) {
        const image = document.createElement('img')
        image.className = 'pack-thumb'
        image.src = thumb.url
        image.alt = ''
        image.loading = 'lazy'
        row.append(image)
      }

      text.append(nameRow, meta)
      row.append(text)

      // 内置包随应用分发，不提供停用与删除，避免做出改不动的假开关。
      if (!isBuiltin) {
        // 损坏包没有可用素材，启用开关没有意义；保留删除入口让用户清理。
        if (!broken) {
          const toggle = document.createElement('label')
          toggle.className = 'pack-toggle'
          const checkbox = document.createElement('input')
          checkbox.type = 'checkbox'
          checkbox.checked = enabled
          checkbox.addEventListener('change', () => {
            void setPackEnabled(pack.id, checkbox.checked)
          })
          toggle.append(checkbox, document.createTextNode(t('packs.enable')))
          row.append(toggle)
        }

        const remove = document.createElement('button')
        remove.type = 'button'
        remove.textContent = t('packs.remove')
        remove.addEventListener('click', () => {
          void removePack(pack.id)
        })

        row.append(remove)
      }

      box.append(row)
    }
  }

  const summaryRow = document.createElement('div')
  summaryRow.className = 'pack-summary'
  summaryRow.textContent = [
    `${t('packs.summaryBuiltin')} ${builtinCount}`,
    `${t('packs.summaryImported')} ${importedCount}`,
    `${t('packs.summaryBroken')} ${brokenCount}`
  ].join(' · ')
  box.append(summaryRow)
}

async function setPackEnabled(packId, enabled) {
  const status = $('packs-status')
  if (typeof window.pet.setPackEnabled !== 'function') return
  try {
    const result = await window.pet.setPackEnabled(packId, enabled)
    if (result?.ok !== true) {
      if (status !== null) {
        status.textContent = `${t('packs.enableFailed')} · ${result?.message ?? ''}`
      }
      return
    }
    packs = Array.isArray(result.packs) ? result.packs : packs
    renderPackList()
    renderPackSelectors()
  } catch (error) {
    if (status !== null) {
      status.textContent = `${t('packs.enableFailed')} · ${
        error instanceof Error ? error.message : String(error)
      }`
    }
  }
}

async function refreshPacks() {
  const status = $('packs-status')
  if (typeof window.pet.listPacks !== 'function') {
    if (status !== null) status.textContent = '当前版本不支持素材包'
    return
  }

  try {
    const result = await window.pet.listPacks()
    packs = Array.isArray(result?.packs) ? result.packs : []
    renderPackList()
    renderPackSelectors()
    if (status !== null) {
      status.textContent =
        result?.ok === true
          ? packs.length === 0
            ? '还没有导入素材包'
            : `已导入 ${packs.length} 个`
          : `读取失败：${result?.message ?? '未知原因'}`
    }
  } catch (error) {
    if (status !== null) {
      status.textContent = `读取失败：${error instanceof Error ? error.message : String(error)}`
    }
  }
}

async function importPack() {
  const button = $('import-pack')
  const status = $('packs-status')
  if (typeof window.pet.importPack !== 'function') return

  if (button !== null) button.disabled = true
  if (status !== null) status.textContent = t('packs.importing')
  try {
    const result = await window.pet.importPack()
    if (result?.canceled === true) {
      if (status !== null) status.textContent = t('packs.importCanceled')
      return
    }
    if (result?.ok !== true) {
      if (status !== null) {
        const reason = packImportReason(result?.code)
        const detail = reason !== '' ? reason : (result?.message ?? t('packs.reasonUnknown'))
        const details = Array.isArray(result?.details) ? result.details : []
        const lines = details
          .slice(0, 6)
          .map((item, index) => {
            const entry = typeof item?.entry === 'string' && item.entry !== '' ? `[${item.entry}] ` : ''
            const message = typeof item?.message === 'string' ? item.message : ''
            return `${index + 1}. ${entry}${message}`.trim()
          })
          .filter((line) => line !== '')
        const more = details.length > lines.length ? `\n…（还有 ${details.length - lines.length} 条）` : ''
        status.textContent =
          lines.length > 0
            ? `${t('packs.importFailed')} · ${detail}\n${lines.join('\n')}${more}`
            : `${t('packs.importFailed')} · ${detail}`
      }
      return
    }
    packs = Array.isArray(result.packs) ? result.packs : packs
    renderPackList()
    renderPackSelectors()
    if (status !== null) {
      const name = result.pack?.name ?? result.pack?.id ?? t('packs.title')
      status.textContent = `${t('packs.imported')}「${name}」`
    }
    showSaved()
  } catch (error) {
    if (status !== null) {
      status.textContent = `${t('packs.importFailed')} · ${
        error instanceof Error ? error.message : String(error)
      }`
    }
  } finally {
    if (button !== null) button.disabled = false
  }
}

async function removePack(packId) {
  if (typeof window.pet.removePack !== 'function') return
  const pack = packs.find((item) => item.id === packId)
  const summary = formatPackCounts(pack?.counts ?? {})
  const detail = summary === '' ? '' : `（${summary}）`
  if (
    !confirmAction({
      message: `删除素材包「${pack?.name || packId}」${detail}？引用它的图标、字体与贴纸会一起清空。`
    })
  ) {
    return
  }

  const status = $('packs-status')
  try {
    const result = await window.pet.removePack(packId)
    if (result?.ok !== true) {
      if (status !== null) status.textContent = `删除失败：${result?.message ?? '未知原因'}`
      return
    }
    packs = Array.isArray(result.packs) ? result.packs : []
    // 主进程会顺手清掉引用，重新读一次设置，别让界面停在旧值上。
    current = await window.pet.getSettings()
    renderPackList()
    renderPackSelectors()
    if (status !== null) status.textContent = `已删除「${packId}」`
    showSaved()
  } catch (error) {
    if (status !== null) {
      status.textContent = `删除失败：${error instanceof Error ? error.message : String(error)}`
    }
  }
}

function bindPackEvents() {
  $('import-pack')?.addEventListener('click', () => {
    void importPack()
  })
  $('refresh-packs')?.addEventListener('click', () => {
    void refreshPacks()
  })

  $('icon-tray')?.addEventListener('change', (event) => {
    void patch({ icon: { tray: event.target.value } })
  })
  $('icon-app')?.addEventListener('change', (event) => {
    void patch({ icon: { app: event.target.value } })
  })
  $('bubble-background')?.addEventListener('change', (event) => {
    renderBubblePreview()
    void patch({ bubble: { background: event.target.value } })
  })
  $('bubble-font')?.addEventListener('change', (event) => {
    renderBubblePreview()
    void patch({ bubble: { fontFamily: event.target.value } })
  })
  $('sticker-source')?.addEventListener('change', (event) => {
    syncStickerGridActive()
    void patch({ sticker: { source: event.target.value } })
  })
  $('bubble-slice')?.addEventListener('change', (event) => {
    const value = Number(event.target.value)
    const slice = Number.isFinite(value) ? Math.min(64, Math.max(4, Math.round(value))) : 12
    event.target.value = String(slice)
    void patch({ bubble: { backgroundSlice: slice } })
  })
}

/** 外部跳转指定的面板；只接受真实存在的 data-panel，拼错就留在当前页。 */
function showPanelIfExists(name) {
  if (typeof name !== 'string' || name === '') return
  const known = [...document.querySelectorAll('.panel')].map((panel) => panel.dataset.panel)
  if (known.includes(name)) showPanel(name)
}

async function main() {
  await loadSettings()
  bindEvents()
  // 素材包清单要等设置读完后才能对齐当前选择。
  await refreshPacks()
  // 素材清单到位后再画预览，否则底图/字体引用解析不到。
  renderBubblePreview()

  // 能力中心用 hash 指定落点（#memory / #voice / #status）；没有 hash 就回到上次看的面板。
  const hashPanel = window.location.hash.replace('#', '')
  if (hashPanel !== '') {
    showPanelIfExists(hashPanel)
  } else {
    const last = readLastPanel()
    if (last !== null) showPanelIfExists(last)
    else showPanel('general')
  }
  refreshLockedState()
  // 设置窗已经开着时，主进程用事件要求切面板。
  window.pet.onSettingsPanel?.((panel) => {
    showPanelIfExists(panel)
  })
  await refreshDiagnostics()
  setInterval(() => {
    void refreshDiagnostics()
  }, 2000)
}

async function exportChatHistory() {
  const status = $('chat-data-status')
  if (typeof window.pet.exportChat !== 'function') return
  if (status !== null) status.textContent = t('data.chatExporting')
  try {
    const result = await window.pet.exportChat()
    if (result?.canceled === true) {
      if (status !== null) status.textContent = t('data.chatReady')
      return
    }
    if (result?.ok !== true) {
      if (status !== null) {
        status.textContent =
          result?.code === 'CHAT_EMPTY'
            ? t('data.chatEmpty')
            : `${t('data.chatFailed')} · ${result?.message ?? ''}`
      }
      return
    }
    if (status !== null) status.textContent = `${t('data.chatExported')} · ${result.path}`
  } catch (error) {
    if (status !== null) {
      status.textContent = `${t('data.chatFailed')} · ${
        error instanceof Error ? error.message : String(error)
      }`
    }
  }
}

async function clearChatHistory() {
  const status = $('chat-data-status')
  if (typeof window.pet.clearChat !== 'function') return
  const ok = confirmAction({
    message: t('data.chatClearConfirm'),
    strength: 'danger',
    confirmWord: t('common.confirmWord')
  })
  if (!ok) return
  try {
    const result = await window.pet.clearChat()
    if (result?.ok === false) {
      throw new Error(String(result.reason ?? 'persist-failed'))
    }
    if (status !== null) status.textContent = t('data.chatCleared')
  } catch (error) {
    if (status !== null) {
      status.textContent = `${t('data.chatFailed')} · ${
        error instanceof Error ? error.message : String(error)
      }`
    }
  }
}

$('chat-export')?.addEventListener('click', () => void exportChatHistory())
$('chat-clear')?.addEventListener('click', () => void clearChatHistory())

void main()
