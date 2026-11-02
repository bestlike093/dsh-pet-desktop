import { describe, expect, it } from 'vitest'
import { ErrorCode } from '@pet/shared'
import { SIZE_PROFILES } from '@pet/shared'
import type { SpriteSheet } from '@pet/shared'
import { AdapterRegistry } from '../adapterRegistry.js'
import type { ImageLike } from '../imageAdapter.js'
import { createSpriteAdapter } from '../spriteAdapter.js'
import { SpriteModel } from '../spriteModel.js'

/* ------------------------------ 测试替身 ------------------------------ */

function fakeImage(): ImageLike {
  return {
    src: '',
    complete: true,
    naturalWidth: 1200,
    naturalHeight: 800,
    onload: null,
    onerror: null
  }
}

function fakeCanvas(): HTMLCanvasElement {
  return { width: 0, height: 0, getContext: () => null } as unknown as HTMLCanvasElement
}

const profile = SIZE_PROFILES.vertical

const sheet: SpriteSheet = {
  image: 'sheet-whale-2f.png',
  grid: { columns: 2, rows: 1, frameWidth: 600, frameHeight: 800 },
  clips: [{ name: 'idle', startFrame: 0, frameCount: 2, fps: 10, loop: true }]
}

function context(spriteSheet: SpriteSheet = sheet) {
  return {
    id: 'sprite-1',
    source: 'blob:sheet-whale-2f.png',
    profile,
    dpr: 1,
    spriteSheet
  }
}

/** 单独构造：不能复用带默认参数的 context，否则 undefined 会回落成有效描述。 */
function contextWithoutSheet() {
  return {
    id: 'sprite-1',
    source: 'blob:sheet-whale-2f.png',
    profile,
    dpr: 1
  }
}

/* ------------------------------ 用例 ------------------------------ */

describe('sprite adapter（B2-5 接线）', () => {
  it('注册类型为 sprite，create 产出 SpriteModel', () => {
    const adapter = createSpriteAdapter({ createImage: fakeImage })
    expect(adapter.kind).toBe('sprite')

    const model = adapter.create(context())
    expect(model).toBeInstanceOf(SpriteModel)
    expect(model.kind).toBe('sprite')
  })

  it('缺少 spriteSheet 时明确报错，不退化成静态图', () => {
    const adapter = createSpriteAdapter({ createImage: fakeImage })
    expect(() => adapter.create(contextWithoutSheet())).toThrowError(
      expect.objectContaining({ code: ErrorCode.INVALID_ARGUMENT })
    )
  })

  it('经 AdapterRegistry 注册后可端到端加载并按帧推进', async () => {
    const registry = new AdapterRegistry()
    registry.register(createSpriteAdapter({ createImage: fakeImage }))

    expect(registry.has('sprite')).toBe(true)

    const model = registry.create('sprite', context())
    model.attach(fakeCanvas())
    await model.load({ source: 'blob:sheet-whale-2f.png', profile, dpr: 1 })

    expect(model.isRenderable()).toBe(true)
    expect((model as SpriteModel).renderState).toBe('ready')
    expect((model as SpriteModel).currentFrame).toBe(0)

    // fps = 10 ⇒ 一帧 100ms；推进 110ms 必须走到第二帧。
    model.tick(0.11)
    expect((model as SpriteModel).currentFrame).toBe(1)
  })

  it('同一适配器可多次 create，各自维护帧位置', async () => {
    const adapter = createSpriteAdapter({ createImage: fakeImage })
    const a = adapter.create(context()) as SpriteModel
    const b = adapter.create(context()) as SpriteModel

    a.attach(fakeCanvas())
    b.attach(fakeCanvas())
    await a.load({ source: 'blob:a', profile, dpr: 1 })
    await b.load({ source: 'blob:b', profile, dpr: 1 })

    a.tick(0.11)
    expect(a.currentFrame).toBe(1)
    expect(b.currentFrame).toBe(0)
  })
})
