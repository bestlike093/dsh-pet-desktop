import { describe, expect, it } from 'vitest'
import { parseSpriteSheet } from '../spriteSheetLoader.js'

const VALID = {
  image: 'pet/idle-sheet.png',
  grid: { columns: 4, rows: 2, frameWidth: 128, frameHeight: 160 },
  clips: [
    { name: 'idle', startFrame: 0, frameCount: 4, fps: 8, loop: true },
    { name: 'tap', startFrame: 4, frameCount: 3, fps: 12, loop: false }
  ]
}

function reasons(result: ReturnType<typeof parseSpriteSheet>): string[] {
  return result.ok ? [] : result.errors.map((error) => `${error.field}:${error.reason}`)
}

describe('parseSpriteSheet', () => {
  it('接受合法描述并原样返回结构', () => {
    const result = parseSpriteSheet(VALID)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.image).toBe('pet/idle-sheet.png')
    expect(result.value.grid.columns).toBe(4)
    expect(result.value.clips).toHaveLength(2)
    expect(result.value.clips[1]?.name).toBe('tap')
  })

  it('拒绝绝对路径与 ..（走既有 validateAssetRef）', () => {
    for (const image of ['/etc/passwd', '\\windows\\x.png', '../escape.png']) {
      expect(reasons(parseSpriteSheet({ ...VALID, image }))).toContain('image:INVALID_RESOURCE')
    }
  })

  it('grid 任一字段非正整数都失败', () => {
    for (const key of ['columns', 'rows', 'frameWidth', 'frameHeight'] as const) {
      const grid = { ...VALID.grid, [key]: 0 }
      expect(reasons(parseSpriteSheet({ ...VALID, grid }))).toContain(`grid.${key}:OUT_OF_RANGE`)
    }
  })

  it('clips 为空数组时失败', () => {
    expect(reasons(parseSpriteSheet({ ...VALID, clips: [] }))).toContain('clips:INVALID_RESOURCE')
  })

  it('片段越界时失败', () => {
    const clips = [{ name: 'idle', startFrame: 6, frameCount: 4, fps: 8, loop: true }]
    expect(reasons(parseSpriteSheet({ ...VALID, clips }))).toContain('clips[0].frameCount:OUT_OF_RANGE')
  })

  it('片段重名时失败', () => {
    const clips = [
      { name: 'idle', startFrame: 0, frameCount: 2, fps: 8, loop: true },
      { name: 'idle', startFrame: 2, frameCount: 2, fps: 8, loop: true }
    ]
    expect(reasons(parseSpriteSheet({ ...VALID, clips }))).toContain('clips[1].name:INVALID_TOKEN')
  })

  it('fps 超出 (0, 120] 时失败', () => {
    for (const fps of [0, -1, 121, Number.NaN, Number.POSITIVE_INFINITY]) {
      const clips = [{ name: 'idle', startFrame: 0, frameCount: 2, fps, loop: true }]
      expect(reasons(parseSpriteSheet({ ...VALID, clips }))).toContain('clips[0].fps:OUT_OF_RANGE')
    }
  })

  it('loop 非布尔时失败', () => {
    const clips = [{ name: 'idle', startFrame: 0, frameCount: 2, fps: 8, loop: 'yes' }]
    expect(reasons(parseSpriteSheet({ ...VALID, clips }))).toContain('clips[0].loop:INVALID_RESOURCE')
  })

  it('J5 反向：非对象输入走校验失败路径，不静默接受', () => {
    for (const raw of [null, undefined, 'sheet', 42, [], [{ name: 'idle' }]]) {
      const result = parseSpriteSheet(raw)
      expect(result.ok).toBe(false)
      expect(result.ok ? [] : result.errors.length).toBeGreaterThan(0)
    }
  })

  it('一次收集多条错误，不在第一条短路', () => {
    const result = parseSpriteSheet({
      image: '',
      grid: { columns: 0, rows: -1, frameWidth: 1.5, frameHeight: 0 },
      clips: 'nope'
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors.length).toBeGreaterThanOrEqual(5)
  })
})
