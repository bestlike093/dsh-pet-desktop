import { describe, expect, it, vi } from 'vitest'
import type { FontSourceV1, StyleTokensV1, ThemeTokensV1 } from '@pet/shared'
import { ThemePort } from '../themePort.js'
import { StylePort } from '../stylePort.js'
import { FontPort } from '../fontPort.js'

function spyPublisher() {
  return { publish: vi.fn(async (_patch: Record<string, string>) => {}) }
}

const THEME: ThemeTokensV1 = {
  id: 'cyrene-pink',
  colors: { primary: '#FF88CC', surface: '#FFF7FB' }
}

const STYLE: StyleTokensV1 = {
  id: 'soft',
  radius: { card: '12px' },
  spacing: { gap: '8px' },
  motion: { hover: '120ms' }
}

function font(id: string, family: string, weight: number): FontSourceV1 {
  return {
    id,
    family,
    format: 'ttf',
    assetRef: `fonts/${id}.ttf`,
    weight,
    style: 'normal'
  }
}

describe('ThemePort', () => {
  it('apply 把色板摊成 colors.* 并只推送一次', async () => {
    const publisher = spyPublisher()
    const port = new ThemePort(publisher)

    await port.apply(THEME)

    expect(publisher.publish).toHaveBeenCalledTimes(1)
    expect(publisher.publish).toHaveBeenCalledWith({
      'colors.primary': '#FF88CC',
      'colors.surface': '#FFF7FB'
    })
  })

  it('非法色值抛错且不推送', async () => {
    const publisher = spyPublisher()
    const port = new ThemePort(publisher)

    await expect(
      port.apply({ id: 'bad', colors: { primary: 'red; background: url(x)' } })
    ).rejects.toThrow()
    expect(publisher.publish).toHaveBeenCalledTimes(0)
  })

  it('一次收集全部字段错误，不在第一条短路', () => {
    const port = new ThemePort(spyPublisher())

    const result = port.validate({
      id: 'bad',
      colors: { primary: '#12', secondary: 'rgb(1,2' }
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors.map((item) => item.field)).toEqual([
        'colors.primary',
        'colors.secondary'
      ])
    }
  })

  it('未 apply 时 describeTokens 返回空数组，而不是抛错', () => {
    const port = new ThemePort(spyPublisher())
    expect(port.describeTokens()).toEqual([])
  })

  it('apply 后 describeTokens 列出当前令牌名', async () => {
    const port = new ThemePort(spyPublisher())
    await port.apply(THEME)
    expect(port.describeTokens()).toEqual(['colors.primary', 'colors.surface'])
  })
})

describe('StylePort', () => {
  it('三组令牌都摊平进同一份载荷', async () => {
    const publisher = spyPublisher()
    const port = new StylePort(publisher)

    await port.apply(STYLE)

    expect(publisher.publish).toHaveBeenCalledWith({
      'radius.card': '12px',
      'spacing.gap': '8px',
      'motion.hover': '120ms'
    })
  })

  it('含 url() 的令牌值被拒绝', () => {
    const port = new StylePort(spyPublisher())
    const result = port.validate({
      id: 'bad',
      radius: {},
      spacing: {},
      motion: { hover: 'url(evil.css)' }
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors[0]?.reason).toBe('INVALID_TOKEN')
  })
})

describe('FontPort.resolve', () => {
  it('命中注册字体时取权重最近的一个', async () => {
    const port = new FontPort(spyPublisher())
    await port.register(font('light', 'Cyrene Sans', 300))
    await port.register(font('bold', 'Cyrene Sans', 700))

    const resolved = port.resolve('Cyrene Sans', 600)

    expect(resolved.isFallback).toBe(false)
    expect(resolved.source.id).toBe('bold')
    expect(resolved.requestedFamily).toBe('Cyrene Sans')
  })

  it('注册表没有但系统回退同名时，算命中而不是 fallback', () => {
    const port = new FontPort(spyPublisher(), {
      fallbacks: [font('sys-yahei', 'Microsoft YaHei', 400)]
    })

    const resolved = port.resolve('Microsoft YaHei', 400)

    expect(resolved.isFallback).toBe(false)
    expect(resolved.source.id).toBe('sys-yahei')
  })

  it('都没有时用回退链第一个，并标记 isFallback', () => {
    const port = new FontPort(spyPublisher(), {
      fallbacks: [font('sys-yahei', 'Microsoft YaHei', 400)]
    })

    const resolved = port.resolve('Not Installed', 400)

    expect(resolved.isFallback).toBe(true)
    expect(resolved.source.family).toBe('Microsoft YaHei')
    expect(resolved.requestedFamily).toBe('Not Installed')
  })

  it('回退链为空时抛 NO_FALLBACK_AVAILABLE，不返回 null', () => {
    const port = new FontPort(spyPublisher())

    expect(() => port.resolve('Missing', 400)).toThrowError(/NO_FALLBACK_AVAILABLE|没有可用字体/)
  })

  it('register 非法字体源会被拒绝', async () => {
    const port = new FontPort(spyPublisher())
    await expect(
      port.register({ ...font('bad', 'Cyrene Sans', 400), assetRef: '../../etc/passwd' })
    ).rejects.toThrow()
  })
})
