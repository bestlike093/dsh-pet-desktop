/**
 * 表情表达实验：把情绪映射到表情标签，并记录命中计数。
 *
 * 三组对照：
 * - off：不启用，始终用默认表情；
 * - experiment：按当前情绪切换表情；
 * - control：保持默认表情，只记录反事实的「本会切到哪个」。
 *
 * 计数只留在内存里供复盘，不落盘、不出网。这里不产生任何台词。
 */

import type { EmotionTag } from '@pet/shared'

export type ExpressionGroup = 'off' | 'experiment' | 'control'

export interface ExpressionOptions {
  readonly group?: ExpressionGroup
  /** 默认表情，neutral 时也用它。 */
  readonly defaultEmotion?: EmotionTag
  readonly now?: () => number
}

export interface ExpressionDecision {
  readonly group: ExpressionGroup
  /** 输入的情绪。 */
  readonly emotion: EmotionTag
  /** 最终要显示的表情。 */
  readonly tag: EmotionTag
  /** 与默认表情不同时为 true。 */
  readonly changed: boolean
  readonly at: number
}

export interface ExpressionStats {
  readonly total: number
  readonly changed: number
  readonly byTag: Readonly<Record<string, number>>
}

export class ExpressionExperiment {
  private readonly now: () => number
  private readonly defaultEmotion: EmotionTag
  private group: ExpressionGroup
  private total = 0
  private changed = 0
  private readonly byTag = new Map<EmotionTag, number>()

  constructor(options: ExpressionOptions = {}) {
    this.now = options.now ?? Date.now
    this.defaultEmotion = options.defaultEmotion ?? 'neutral'
    this.group = options.group ?? 'off'
  }

  get currentGroup(): ExpressionGroup {
    return this.group
  }

  setGroup(group: ExpressionGroup): void {
    this.group = group
  }

  decide(emotion: EmotionTag): ExpressionDecision {
    const at = this.now()
    const wanted = emotion === 'neutral' ? this.defaultEmotion : emotion
    const tag = this.group === 'experiment' ? wanted : this.defaultEmotion
    const changed = tag !== this.defaultEmotion

    // off 不算实验数据，免得把「没开」混进对照结果。
    if (this.group !== 'off') {
      this.total += 1
      if (changed) this.changed += 1
      this.byTag.set(tag, (this.byTag.get(tag) ?? 0) + 1)
    }

    return { group: this.group, emotion, tag, changed, at }
  }

  stats(): ExpressionStats {
    const byTag: Record<string, number> = {}
    for (const [tag, count] of this.byTag) byTag[tag] = count
    return { total: this.total, changed: this.changed, byTag }
  }

  resetStats(): void {
    this.total = 0
    this.changed = 0
    this.byTag.clear()
  }
}
