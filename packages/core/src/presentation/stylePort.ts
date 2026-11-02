/**
 * 风格端口实现（S7-d）。
 *
 * 形状 / 间距 / 动效三组令牌的值都是 CSS 片段，统一走 `validateCssValue`。
 * 载荷键形如 `radius.card`、`spacing.gap`、`motion.hover`。
 */

import {
  type IStylePortV1,
  type StyleTokensV1,
  type TokenPatchV1,
  type ValidationResultV1
} from '@pet/shared'
import { PresentationPortBase } from './portBase.js'
import { validateStyleTokens } from './validators.js'

const GROUPS = ['radius', 'spacing', 'motion'] as const

export class StylePort extends PresentationPortBase<StyleTokensV1> implements IStylePortV1 {
  protected toPatch(value: StyleTokensV1): TokenPatchV1 {
    const patch: Record<string, string> = {}
    for (const group of GROUPS) {
      for (const [name, raw] of Object.entries(value[group])) {
        patch[`${group}.${name}`] = raw
      }
    }
    return patch
  }

  validate(value: StyleTokensV1): ValidationResultV1 {
    return validateStyleTokens(value)
  }

  describeTokens(): readonly string[] {
    const value = this.currentOrUndefined()
    if (value === undefined) return []
    return GROUPS.flatMap((group) => Object.keys(value[group]).map((name) => `${group}.${name}`))
  }
}
