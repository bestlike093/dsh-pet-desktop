import { describe, expect, it } from 'vitest'
import { SIZE_PROFILES } from '@pet/shared'
import type { IModel } from '@pet/shared'
import { createVideoAdapter } from '../videoAdapter.js'
import type { VideoLike } from '../videoAdapter.js'

interface VideoProbe {
  video: VideoLike
  removedAttributes: string[]
  loads: number
  srcWrites: string[]
}

function makeVideo(): VideoProbe {
  const probe: VideoProbe = {
    video: {} as VideoLike,
    removedAttributes: [],
    loads: 0,
    srcWrites: []
  }

  let src = ''
  const video: VideoLike = {
    get src() {
      return src
    },
    set src(value: string) {
      src = value
      probe.srcWrites.push(value)
    },
    readyState: 0,
    videoWidth: 640,
    videoHeight: 360,
    muted: false,
    loop: false,
    onloadedmetadata: null,
    onloadeddata: null,
    onerror: null,
    play: () => Promise.resolve(),
    pause: () => undefined,
    load: () => {
      probe.loads += 1
      // 真实元素 load 后会触发 loadeddata；这里用微任务模拟。
      queueMicrotask(() => video.onloadeddata?.())
    },
    removeAttribute: (name) => {
      probe.removedAttributes.push(name)
    },
    remove: () => undefined
  }
  probe.video = video
  return probe
}

describe('video 生命周期', () => {
  it('切源 20 次：活动元素数恒为 1，旧元素逐次摘除', async () => {
    const profile = SIZE_PROFILES.vertical
    const live = new Set<VideoLike>()
    const removed: VideoLike[] = []

    const adapter = createVideoAdapter({
      createVideo: () => {
        const { video } = makeVideo()
        live.add(video)
        return video
      },
      releaseVideo: (video) => {
        live.delete(video)
        removed.push(video)
      }
    })

    let current: IModel | null = null
    for (let i = 0; i < 20; i += 1) {
      const source = `blob:mock/${i}`
      const model = adapter.create({ id: `v-${i}`, source, profile, dpr: 1 })
      await model.load({ source, profile, dpr: 1 })
      if (current !== null) current.dispose()
      current = model
      expect(live.size).toBe(1)
    }

    expect(removed).toHaveLength(19)
  })

  it('dispose 断开 src 并 load：不用空串顶替，事件回调用 null 清空', async () => {
    const profile = SIZE_PROFILES.vertical
    const probe = makeVideo()
    const adapter = createVideoAdapter({
      createVideo: () => probe.video,
      releaseVideo: () => undefined
    })

    const model = adapter.create({ id: 'v', source: 'blob:mock/1', profile, dpr: 1 })
    await model.load({ source: 'blob:mock/1', profile, dpr: 1 })
    model.dispose()

    expect(probe.removedAttributes).toEqual(['src'])
    // 赋空串会让浏览器把页面 URL 当源；只允许加载时那一次真实赋值。
    expect(probe.srcWrites).toEqual(['blob:mock/1'])
    expect(probe.loads).toBe(2)
    expect(probe.video.onloadedmetadata).toBeNull()
    expect(probe.video.onloadeddata).toBeNull()
    expect(probe.video.onerror).toBeNull()
  })

  it('dispose 幂等：重复释放不会二次摘除', async () => {
    const profile = SIZE_PROFILES.vertical
    const removed: VideoLike[] = []
    const adapter = createVideoAdapter({
      createVideo: () => makeVideo().video,
      releaseVideo: (video) => removed.push(video)
    })

    const model = adapter.create({ id: 'v', source: 'blob:mock/1', profile, dpr: 1 })
    await model.load({ source: 'blob:mock/1', profile, dpr: 1 })

    model.dispose()
    model.dispose()

    expect(removed).toHaveLength(1)
    expect(model.isRenderable()).toBe(false)
  })
})
