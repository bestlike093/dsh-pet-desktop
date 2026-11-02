/**
 * 渲染状态 → 可见提示（B2-4 接线）。
 *
 * `SpriteModel.renderState` 只说明「现在是什么状态」，没人读它画面就还是空白。
 * 这里把状态翻译成上层要做的动作，并保证只在**变化时**触发，
 * 避免每帧写 DOM（4fps 也不便宜，而且是没必要的）。
 *
 * 已知边界：本模块只决定「该显示什么」，不负责样式与位置。
 */
import type { SpriteRenderState } from './spriteModel.js'

export type RenderNotice = 'none' | 'loading' | 'failed'

/** 状态到提示的映射。`disposed` 不提示——模型已释放，提示会盖在下一个模型上。 */
export function noticeFor(state: SpriteRenderState): RenderNotice {
  switch (state) {
    case 'idle':
    case 'loading':
      return 'loading'
    case 'failed':
      return 'failed'
    case 'ready':
    case 'disposed':
      return 'none'
  }
}

export interface NoticeTarget {
  show(kind: Exclude<RenderNotice, 'none'>): void
  hide(): void
}

export interface RenderNoticePump {
  readonly current: RenderNotice
  /** 推入一次状态；只有提示种类变化时才调用 target。返回本次是否发生变化。 */
  push(state: SpriteRenderState): boolean
  /** 停止推送（不调用 target）。 */
  dispose(): void
}

export function createRenderNoticePump(target: NoticeTarget): RenderNoticePump {
  let current: RenderNotice = 'none'
  let disposed = false

  return {
    get current() {
      return current
    },
    push(state) {
      if (disposed) return false
      const next = noticeFor(state)
      if (next === current) return false
      current = next
      if (next === 'none') target.hide()
      else target.show(next)
      return true
    },
    dispose() {
      disposed = true
    }
  }
}
