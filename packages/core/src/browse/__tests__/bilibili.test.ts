import { describe, expect, it } from 'vitest'
import {
  BilibiliReadOnlyError,
  assertReadOnly,
  digestVideo,
  extractRepoRefs,
  isReadOnlyAction,
  isWorthFollowing,
  parseVideoRef
} from '../bilibili.js'

describe('只读白名单', () => {
  it('四个只读动作通过', () => {
    for (const action of ['search', 'open', 'read-intro', 'list-related']) {
      expect(isReadOnlyAction(action)).toBe(true)
      expect(() => assertReadOnly(action)).not.toThrow()
    }
  })

  it('点赞、投币、收藏、发言全部拒绝', () => {
    for (const action of ['like', 'coin', 'favorite', 'comment', 'danmaku', 'follow']) {
      expect(isReadOnlyAction(action)).toBe(false)
      expect(() => assertReadOnly(action)).toThrow(BilibiliReadOnlyError)
    }
  })

  it('错误里带上被拒绝的动作名', () => {
    try {
      assertReadOnly('like')
    } catch (error) {
      expect((error as BilibiliReadOnlyError).action).toBe('like')
    }
  })
})

describe('parseVideoRef', () => {
  it('从完整 URL 取 bvid', () => {
    expect(parseVideoRef('https://www.bilibili.com/video/BV1eAs96TEM2/?vd_source=x')).toEqual({
      bvid: 'BV1eAs96TEM2'
    })
  })

  it('裸 BV 号也能取', () => {
    expect(parseVideoRef('BV16Axe6bEhh')).toEqual({ bvid: 'BV16Axe6bEhh' })
  })

  it('取不到时返回 null', () => {
    expect(parseVideoRef('https://www.bilibili.com/video/av123')).toBeNull()
    expect(parseVideoRef('随便一段话')).toBeNull()
  })
})

describe('extractRepoRefs', () => {
  it('单个仓库', () => {
    expect(extractRepoRefs('仓库在简介：https://github.com/yuanstarstar/dsh-game-stack')).toEqual([
      { owner: 'yuanstarstar', repo: 'dsh-game-stack', url: 'https://github.com/yuanstarstar/dsh-game-stack' }
    ])
  })

  it('多个仓库', () => {
    const refs = extractRepoRefs(
      'a https://github.com/a/one 和 b https://github.com/b/two'
    )
    expect(refs.map((ref) => ref.repo)).toEqual(['one', 'two'])
  })

  it('去重', () => {
    const refs = extractRepoRefs(
      'https://github.com/a/one 再说一次 https://github.com/a/one'
    )
    expect(refs).toHaveLength(1)
  })

  it('去掉尾部标点', () => {
    const refs = extractRepoRefs('看这里 https://github.com/a/one。')
    expect(refs[0]?.repo).toBe('one')
  })

  it('没有链接时返回空数组', () => {
    expect(extractRepoRefs('没有仓库')).toEqual([])
  })
})

describe('digestVideo', () => {
  const description = [
    '五个插件，2.0 MB，解压 + 一个脚本 + 重启一次。',
    '01 眼睛和手 —— 抓帧、认字、点击、按键',
    '02 脑子 —— 规则、流程、四道闸门、记忆',
    '先说实话：这一版只是能跑，离打得好看还差很远。',
    '仓库在简介：https://github.com/yuanstarstar/dsh-game-stack',
    '想让她学哪款游戏，评论区点。'
  ].join('\n')

  it('摘出仓库', () => {
    const digest = digestVideo({
      title: '什么？你的肥鱼还不会自己打游戏',
      url: 'https://www.bilibili.com/video/BV16Axe6bEhh/',
      description
    })
    expect(digest.repos).toHaveLength(1)
    expect(digest.bvid).toBe('BV16Axe6bEhh')
  })

  it('摘出作者自陈的边界', () => {
    const digest = digestVideo({ title: 't', description })
    expect(digest.limits).toEqual(['先说实话：这一版只是能跑，离打得好看还差很远。'])
  })

  it('保留原文', () => {
    const digest = digestVideo({ title: 't', description })
    expect(digest.body).toContain('四道闸门')
  })

  it('没有 URL 时不给 bvid 字段', () => {
    const digest = digestVideo({ title: 't', description })
    expect(digest.bvid).toBeUndefined()
  })
})

describe('isWorthFollowing', () => {
  it('有仓库就值得追', () => {
    const digest = digestVideo({
      title: 't',
      description: 'https://github.com/a/one'
    })
    expect(isWorthFollowing(digest)).toBe(true)
  })

  it('只有边界也值得追', () => {
    const digest = digestVideo({ title: 't', description: '已知边界：只支持 1080p' })
    expect(isWorthFollowing(digest)).toBe(true)
  })

  it('什么都没有就不追', () => {
    const digest = digestVideo({ title: 't', description: '今天天气不错' })
    expect(isWorthFollowing(digest)).toBe(false)
  })
})
