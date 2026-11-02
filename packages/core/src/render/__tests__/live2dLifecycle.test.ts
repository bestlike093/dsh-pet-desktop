import { afterEach, describe, expect, it } from 'vitest'
import { SIZE_PROFILES } from '@pet/shared'
import { Live2DModel, ensureLive2DScripts } from '../live2dAdapter.js'

interface FakeScript {
  src: string
  async: boolean
  onload: (() => void) | null
  onerror: ((error: unknown) => void) | null
  remove: () => void
}

function installFakeDocument(behavior: 'fail' | 'ok'): { appended: FakeScript[]; restore: () => void } {
  const appended: FakeScript[] = []

  const doc = {
    createElement: (): FakeScript => {
      const script: FakeScript = {
        src: '',
        async: false,
        onload: null,
        onerror: null,
        remove: () => {
          const index = appended.indexOf(script)
          if (index >= 0) appended.splice(index, 1)
        }
      }
      return script
    },
    head: {
      appendChild: (script: FakeScript): FakeScript => {
        appended.push(script)
        queueMicrotask(() => {
          if (behavior === 'ok') script.onload?.()
          else script.onerror?.(new Error('boom'))
        })
        return script
      }
    }
  }

  const globals = globalThis as unknown as { document?: unknown }
  const previous = globals.document
  globals.document = doc

  return {
    appended,
    restore: () => {
      if (previous === undefined) delete globals.document
      else globals.document = previous
    }
  }
}

afterEach(() => {
  delete (globalThis as unknown as { document?: unknown }).document
})

describe('Live2D 脚本注入生命周期', () => {
  it('加载失败时移除标签：head 里不累积失效 script', async () => {
    const { appended, restore } = installFakeDocument('fail')
    try {
      await expect(
        ensureLive2DScripts({ core: 'blob:fail/core.js', pixi: 'blob:fail/pixi.js', live2d: 'blob:fail/live2d.js' })
      ).rejects.toThrow()
      expect(appended).toHaveLength(0)
    } finally {
      restore()
    }
  })

  it('加载成功后保留标签：同一 src 只注入一次', async () => {
    const { appended, restore } = installFakeDocument('ok')
    try {
      const scripts = { core: 'blob:ok/core.js', pixi: 'blob:ok/pixi.js', live2d: 'blob:ok/live2d.js' }
      await ensureLive2DScripts(scripts)
      await ensureLive2DScripts(scripts)

      expect(appended).toHaveLength(3)
    } finally {
      restore()
    }
  })

  it('dispose 带纹理参数销毁：children / texture / baseTexture 全为 true', async () => {
    const { restore } = installFakeDocument('ok')
    const globals = globalThis as unknown as { PIXI?: unknown }
    const previousPixi = globals.PIXI
    const calls: Array<Record<string, boolean> | undefined> = []

    globals.PIXI = {
      live2d: {
        Live2DModel: {
          from: async () => ({
            update: () => undefined,
            destroy: (options?: Record<string, boolean>) => calls.push(options)
          })
        }
      }
    }

    try {
      const profile = SIZE_PROFILES.vertical
      const model = new Live2DModel(
        { id: 'l2d', source: 'blob:l2d/model.json', profile, dpr: 1 },
        {
          scripts: {
            core: 'blob:ok2/core.js',
            pixi: 'blob:ok2/pixi.js',
            live2d: 'blob:ok2/live2d.js'
          }
        }
      )

      await model.load({ source: 'blob:l2d/model.json', profile, dpr: 1 })
      model.dispose()

      expect(calls).toEqual([{ children: true, texture: true, baseTexture: true }])
    } finally {
      restore()
      if (previousPixi === undefined) delete globals.PIXI
      else globals.PIXI = previousPixi
    }
  })
})
