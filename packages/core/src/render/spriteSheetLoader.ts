/**
 * 帧序列描述解析器（B2-1）。
 *
 * 只做「把外部描述变成可信的 SpriteSheet」这一件事：
 * 纯函数、不做 IO、不碰 DOM。图像本体仍交给既有适配器加载，
 * 这里只回答「怎么切、怎么排」。
 *
 * 资源引用走既有的 `validateAssetRef`，不另开一条校验路径（13.6.5）。
 */
import type { FieldErrorV1, SpriteSheet, SpriteSheetClip } from '@pet/shared'
import { validateAssetRef } from '../presentation/validators.js'

export type SpriteSheetParseResult =
  | { readonly ok: true; readonly value: SpriteSheet }
  | { readonly ok: false; readonly errors: readonly FieldErrorV1[] }

/** 帧率上限：高于它基本等于笔误，也避免 dt 归一化时出现极小数。 */
const MAX_FPS = 120

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function invalid(field: string, hint: string, reason: FieldErrorV1['reason'] = 'INVALID_RESOURCE'): FieldErrorV1 {
  return { field, reason, hint }
}

function parseGrid(raw: unknown, errors: FieldErrorV1[]): SpriteSheet['grid'] | null {
  if (!isRecord(raw)) {
    errors.push(invalid('grid', 'grid 必须是对象，含 columns / rows / frameWidth / frameHeight'))
    return null
  }

  let ok = true
  for (const key of ['columns', 'rows', 'frameWidth', 'frameHeight'] as const) {
    if (!isPositiveInt(raw[key])) {
      errors.push(invalid(`grid.${key}`, `${key} 必须是正整数`, 'OUT_OF_RANGE'))
      ok = false
    }
  }
  if (!ok) return null

  const columns = raw.columns as number
  const rows = raw.rows as number
  const frameWidth = raw.frameWidth as number
  const frameHeight = raw.frameHeight as number
  return { columns, rows, frameWidth, frameHeight }
}

function parseClip(
  raw: unknown,
  index: number,
  totalFrames: number,
  seenNames: Set<string>,
  errors: FieldErrorV1[]
): SpriteSheetClip | null {
  const path = `clips[${index}]`
  if (!isRecord(raw)) {
    errors.push(invalid(path, '片段必须是对象'))
    return null
  }

  let ok = true

  const name = raw.name
  if (typeof name !== 'string' || name.length === 0) {
    errors.push(invalid(`${path}.name`, '片段名不能为空', 'INVALID_TOKEN'))
    ok = false
  } else if (seenNames.has(name)) {
    errors.push(invalid(`${path}.name`, `片段名重复：${name}`, 'INVALID_TOKEN'))
    ok = false
  } else {
    seenNames.add(name)
  }

  const startFrame = raw.startFrame
  if (!isNonNegativeInt(startFrame)) {
    errors.push(invalid(`${path}.startFrame`, 'startFrame 必须是非负整数', 'OUT_OF_RANGE'))
    ok = false
  }

  const frameCount = raw.frameCount
  if (!isPositiveInt(frameCount)) {
    errors.push(invalid(`${path}.frameCount`, 'frameCount 必须是正整数', 'OUT_OF_RANGE'))
    ok = false
  }

  const fps = raw.fps
  if (typeof fps !== 'number' || !Number.isFinite(fps) || fps <= 0 || fps > MAX_FPS) {
    errors.push(invalid(`${path}.fps`, `fps 必须在 (0, ${MAX_FPS}] 之间`, 'OUT_OF_RANGE'))
    ok = false
  }

  const loop = raw.loop
  if (typeof loop !== 'boolean') {
    errors.push(invalid(`${path}.loop`, 'loop 必须是布尔值'))
    ok = false
  }

  if (ok && isNonNegativeInt(startFrame) && isPositiveInt(frameCount) && startFrame + frameCount > totalFrames) {
    errors.push(
      invalid(
        `${path}.frameCount`,
        `片段超出帧总数：${startFrame} + ${frameCount} > ${totalFrames}`,
        'OUT_OF_RANGE'
      )
    )
    ok = false
  }

  if (!ok) return null
  return {
    name: name as string,
    startFrame: startFrame as number,
    frameCount: frameCount as number,
    fps: fps as number,
    loop: loop as boolean
  }
}

/**
 * 解析外部帧序列描述。
 *
 * 任一字段不合格都会收集进 errors 后整体失败，不做「部分可用」的降级——
 * 静默接受残缺描述会在播放期变成难查的空帧。
 */
export function parseSpriteSheet(raw: unknown): SpriteSheetParseResult {
  if (!isRecord(raw)) {
    return {
      ok: false,
      errors: [invalid('', '帧序列描述必须是对象', 'INVALID_TOKEN')]
    }
  }

  const errors: FieldErrorV1[] = []

  const image = raw.image
  if (typeof image !== 'string') {
    errors.push(invalid('image', 'image 必须是资源引用字符串'))
  } else {
    errors.push(...validateAssetRef('image', image))
  }

  const grid = parseGrid(raw.grid, errors)
  const totalFrames = grid === null ? 0 : grid.columns * grid.rows

  const clipsRaw = raw.clips
  const clips: SpriteSheetClip[] = []
  if (!Array.isArray(clipsRaw) || clipsRaw.length === 0) {
    errors.push(invalid('clips', 'clips 必须是非空数组'))
  } else if (grid !== null) {
    const seen = new Set<string>()
    for (let i = 0; i < clipsRaw.length; i += 1) {
      const clip = parseClip(clipsRaw[i], i, totalFrames, seen, errors)
      if (clip !== null) clips.push(clip)
    }
  }

  if (errors.length > 0) return { ok: false, errors }

  return {
    ok: true,
    value: {
      image: image as string,
      grid: grid as SpriteSheet['grid'],
      clips
    }
  }
}
