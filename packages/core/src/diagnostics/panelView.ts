import { ErrorCode, fixHintOf } from '@pet/shared'
import type { DiagnosticsSection, DiagnosticsSnapshot } from './diagnostics.js'

export type PanelRowLevel = 'ok' | 'warn' | 'error'

export interface PanelRowView {
  readonly id: string
  readonly label: string
  /** 第一级分组，来自 section.data.group。 */
  readonly group: string
  /** 第二级分类，来自 section.data.kind。 */
  readonly kind: string
  readonly level: PanelRowLevel
  readonly detail: string
  /** 永远非空：数据源没给就按错误码补，码也没登记则给兜底文案。 */
  readonly fixHint: string
  readonly code?: string
  /**
   * 只供界面展示，复制导出时不会读取这个字段。
   * 恢复出来的旧密钥路径属于本机证据，不该跟着报告发出去。
   */
  readonly recoveredFrom?: string
}

export interface PanelGroupView {
  readonly group: string
  readonly rows: readonly PanelRowView[]
}

export interface PanelViewModel {
  readonly title: string
  readonly generatedAt: number
  readonly ok: boolean
  readonly groups: readonly PanelGroupView[]
}

const FALLBACK_FIX_HINT = '无额外修复建议，按日志中的 code 排查。'

function isErrorCode(code: string): code is ErrorCode {
  return (Object.values(ErrorCode) as readonly string[]).includes(code)
}

function sectionData(section: DiagnosticsSection): Record<string, unknown> {
  if (typeof section.data !== 'object' || section.data === null || Array.isArray(section.data)) return {}
  return section.data as Record<string, unknown>
}

function asText(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function describeSection(section: DiagnosticsSection): string {
  if (section.data === undefined) return section.message ?? (section.ok ? '已就绪' : '')
  if (typeof section.data !== 'object' || section.data === null || Array.isArray(section.data)) {
    try {
      return JSON.stringify(section.data)
    } catch {
      return ''
    }
  }

  const data = section.data as Record<string, unknown>
  return Object.entries(data)
    // recoveredFrom 单独渲染，不混进 detail，避免顺手被复制导出。
    .filter(([key]) => key !== 'recoveredFrom')
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(' · ')
}

/**
 * fixHint 的取值顺序（17.2.17）：错误码表 → 数据源自带 → 兜底文案。
 * 空字符串也算「没给」，否则界面会出现一条没有建议的修复建议。
 */
function resolveFixHint(section: DiagnosticsSection, data: Record<string, unknown>): string {
  if (section.code !== undefined && isErrorCode(section.code)) {
    const hint = fixHintOf(section.code)
    if (hint.length > 0) return hint
  }

  const declared = asText(data.fixHint)
  if (declared !== undefined) return declared

  return FALLBACK_FIX_HINT
}

/**
 * 把快照整理成 group → kind 两级视图。
 *
 * 分组顺序按首次出现；组内按 kind 字典序，保证同一份快照每次渲染位置一致。
 */
export function buildPanelView(snapshot: DiagnosticsSnapshot, labels: Record<string, string> = {}): PanelViewModel {
  const groups = new Map<string, PanelRowView[]>()

  for (const section of snapshot.sections) {
    const data = sectionData(section)
    const group = asText(data.group) ?? 'general'
    const kind = asText(data.kind) ?? section.name
    const recoveredFrom = asText(data.recoveredFrom)

    const row: PanelRowView = {
      id: section.name,
      label: labels[section.name] ?? section.name,
      group,
      kind,
      level: section.level ?? (section.ok ? 'ok' : 'error'),
      detail: describeSection(section),
      fixHint: resolveFixHint(section, data),
      ...(section.code === undefined ? {} : { code: section.code }),
      ...(recoveredFrom === undefined ? {} : { recoveredFrom })
    }

    const bucket = groups.get(group)
    if (bucket === undefined) groups.set(group, [row])
    else bucket.push(row)
  }

  const ordered: PanelGroupView[] = []
  for (const [group, rows] of groups) {
    ordered.push({
      group,
      rows: [...rows].sort((left, right) => left.kind.localeCompare(right.kind))
    })
  }

  return {
    title: `桌宠诊断 ${snapshot.version}`,
    generatedAt: snapshot.generatedAt,
    ok: snapshot.sections.every((section) => (section.level ?? (section.ok ? 'ok' : 'error')) !== 'error'),
    groups: ordered
  }
}

export function panelRows(view: PanelViewModel): readonly PanelRowView[] {
  return view.groups.flatMap((group) => group.rows)
}
