/**
 * 17.3.3.8 契约级约束：异步回填路径上的 dispose 守卫。
 * 断言「不产生副作用」，比「不抛错」更严：不写 canvas、不回填字段、拿到资源要释放。
 */
import { describe, expect, it } from 'vitest'
import { SIZE_PROFILES } from '@pet/shared'
import type { IModel, LoadContext } from '@pet/shared'
import type { ModelAdapter } from '../adapterRegistry.js'
import { ImageModel } from '../imageAdapter.js'
import type { ImageLike } from '../imageAdapter.js'
import { createLive2DAdapter } from '../live2dAdapter.js'
import type { LoadedLive2D, Live2DLoader } from '../live2dAdapter.js'

const context = { id: 'async-dispose', source: 'memory://fixture', profile: SIZE_PROFILES.square, dpr: 1 }

function loadContext(): LoadContext {
  return { source: 'memory://fixture', profile: SIZE_PROFILES.square, dpr: 1 }
}

function pendingImage(): ImageLike {
  return {
    complete: false,
    naturalWidth: 128,
    naturalHeight: 128,
    crossOrigin: '',
    onload: null,
    onerror: null,
    src: ''
  }
}

describe('ImageModel：load 在途时 dispose', () => {
  it('旧 onload 仍被派发也不回填、不绘制', async () => {
    const image = pendingImage()
    const model = new ImageModel(context, { createImage: () => image })
    const pending = model.load(loadContext())

    const staleOnload = image.onload
    model.dispose()
    expect(image.onload).toBeNull()

    expect(() => staleOnload?.()).not.toThrow()
    await pending

    expect(model.isRenderable()).toBe(false)
    expect(image.onload).toBeNull()
  })
})

describe('Live2DModel：加载在途时 dispose', () => {
  it('主路径 resolve 后销毁模型，不挂载、不回填', async () => {
    let resolveLoad: (value: LoadedLive2D) => void = () => {}
    const loader: Live2DLoader = {
      load: () =>
        new Promise<LoadedLive2D>((resolve) => {
          resolveLoad = resolve
        })
    }
    let destroyed = 0
    const loaded: LoadedLive2D = {
      tick: () => {},
      destroy: () => {
        destroyed += 1
      },
      setExpression: () => {},
      attachTo: () => {
        throw new Error('dispose 后不应挂载')
      }
    }

    const adapter = createLive2DAdapter({ loader })
    const model = adapter.create(context)
    const pending = model.load(loadContext())

    model.dispose()
    resolveLoad(loaded)
    await pending

    expect(destroyed).toBe(1)
    expect(model.isRenderable()).toBe(false)
  })

  it('降级路径 resolve 后释放 delegate，不覆盖已置空字段', async () => {
    const loader: Live2DLoader = {
      load: async () => {
        throw new Error('force fallback')
      }
    }

    let resolveDelegateLoad: () => void = () => {}
    let delegateDisposed = 0
    const delegateModel: IModel = {
      id: 'fallback',
      kind: 'image',
      profile: SIZE_PROFILES.square,
      load: () =>
        new Promise<void>((resolve) => {
          resolveDelegateLoad = resolve
        }),
      attach: () => {},
      resize: () => {},
      tick: () => {},
      pause: () => {},
      resume: () => {},
      dispose: () => {
        delegateDisposed += 1
      },
      isRenderable: () => false
    }
    const fallback: ModelAdapter = { kind: 'image', create: () => delegateModel }

    const adapter = createLive2DAdapter({ loader, fallback })
    const model = adapter.create(context)
    const pending = model.load(loadContext())

    // 等 catch 分支把 delegate 建出来
    await Promise.resolve()
    model.dispose()

    resolveDelegateLoad()
    await pending

    expect(delegateDisposed).toBe(1)
    expect(model.isRenderable()).toBe(false)
  })
})
