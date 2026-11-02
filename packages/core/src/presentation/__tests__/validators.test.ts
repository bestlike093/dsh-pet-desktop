import { describe, expect, it } from 'vitest'
import type { FontSourceV1, StyleTokensV1, ThemeTokensV1 } from '@pet/shared'
import {
  validateAssetRef,
  validateColor,
  validateCssValue,
  validateFontFamily,
  validateFontSource,
  validateFontWeight,
  validateStyleTokens,
  validateThemeTokens
} from '../validators.js'

describe('S7-d 颜色白名单', () => {
  it('接受十六进制、rgb()/rgba() 与预置变量名', () => {
    for (const value of ['#fff', '#FF88CC', '#FF88CC80', 'rgb(255, 136, 204)', 'rgba(255,136,204,0.5)', 'sakura-pink']) {
      expect(validateColor('colors.primary', value)).toEqual([])
    }
  })

  it('拒绝注入形状', () => {
    for (const value of ['red; background: url(x)', '#fff}', 'url(http://x)', 'rgb(1,2)']) {
      const errors = validateColor('colors.primary', value)
      expect(errors).toHaveLength(1)
      expect(errors[0]?.reason).toBe('INVALID_COLOR')
      expect(errors[0]?.field).toBe('colors.primary')
    }
  })
})

describe('S7-d 字体名与权重', () => {
  it('拒绝 url( 与括号', () => {
    for (const value of ['url(x)', 'My;Font', 'Font)', ' font(']) {
      const errors = validateFontFamily('family', value)
      expect(errors).toHaveLength(1)
      expect(errors[0]?.reason).toBe('INVALID_FAMILY')
      // 相邻同类型参数传反时 reason 不变，只有 field 能抓住
      expect(errors[0]?.field).toBe('family')
    }
  })

  it('接受常规字体名', () => {
    expect(validateFontFamily('family', 'Source Han Sans SC')).toEqual([])
  })

  it('权重超出 100–900 或非整数都拒绝', () => {
    for (const value of [50, 950, 400.5, Number.NaN]) {
      const errors = validateFontWeight('weight', value)
      expect(errors).toHaveLength(1)
      expect(errors[0]?.reason).toBe('OUT_OF_RANGE')
      // 同上：field 是唯一能暴露参数顺序错的断言
      expect(errors[0]?.field).toBe('weight')
    }
  })
})

describe('S7-d 收集全部错误（不短路）', () => {
  it('三个非法颜色 → 恰好 3 条，逐条对齐字段', () => {
    const theme: ThemeTokensV1 = {
      id: 'bad',
      colors: { primary: 'red;', secondary: '#fff}', accent: 'url(x)' }
    }

    const result = validateThemeTokens(theme)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors).toHaveLength(3)
    expect(result.errors.map((item) => item.field).sort()).toEqual([
      'colors.accent',
      'colors.primary',
      'colors.secondary'
    ])
    expect(result.errors.every((item) => item.reason === 'INVALID_COLOR')).toBe(true)
  })

  it('字体同时有 family / weight / assetRef 三处错 → 3 条', () => {
    const font: FontSourceV1 = {
      id: 'bad',
      family: 'url(x)',
      format: 'ttf',
      assetRef: '../escape.ttf',
      weight: 20,
      style: 'normal'
    }

    const result = validateFontSource(font)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors).toHaveLength(3)

    const byField = (field: string) => result.errors.find((item) => item.field === field)
    expect(byField('family')?.reason).toBe('INVALID_FAMILY')
    expect(byField('weight')?.reason).toBe('OUT_OF_RANGE')
    expect(byField('assetRef')?.reason).toBe('INVALID_RESOURCE')
  })

  it('风格三组各自的非法值都会被收集', () => {
    const style: StyleTokensV1 = {
      id: 'bad',
      radius: { sm: '4px;', md: '8px' },
      spacing: { md: '8px' },
      motion: { fast: 'url(x)' }
    }

    const result = validateStyleTokens(style)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors).toHaveLength(2)
    expect(result.errors.map((item) => item.field).sort()).toEqual(['motion.fast', 'radius.sm'])
    expect(result.errors.every((item) => item.reason === 'INVALID_TOKEN')).toBe(true)
  })

  it('全部合法时返回 ok:true 且不带 errors', () => {
    const theme: ThemeTokensV1 = { id: 'good', colors: { primary: '#FF88CC' } }
    const result = validateThemeTokens(theme)

    expect(result).toEqual({ ok: true })
  })
})

describe('S7-d 资源引用', () => {
  it('拒绝绝对路径与 ../', () => {
    for (const value of ['/etc/passwd', '\\windows\\x.ttf', '../../escape.ttf', 'fonts/../../x.ttf']) {
      const errors = validateAssetRef('assetRef', value)
      expect(errors).toHaveLength(1)
      expect(errors[0]?.reason).toBe('INVALID_RESOURCE')
      expect(errors[0]?.field).toBe('assetRef')
    }
  })

  it('接受相对引用', () => {
    expect(validateAssetRef('assetRef', 'fonts/sakura.woff2')).toEqual([])
  })
})

describe('S7-d 通用令牌值', () => {
  it('拒绝分号、花括号与 url(', () => {
    for (const value of ['4px;', '4px}', '4px)', 'url(x)']) {
      const errors = validateCssValue('radius.sm', value)
      expect(errors).toHaveLength(1)
      expect(errors[0]?.reason).toBe('INVALID_TOKEN')
      expect(errors[0]?.field).toBe('radius.sm')
    }
  })

  it('空值单独报 INVALID_TOKEN', () => {
    const errors = validateCssValue('radius.sm', '')
    expect(errors).toHaveLength(1)
    expect(errors[0]?.reason).toBe('INVALID_TOKEN')
  })
})
