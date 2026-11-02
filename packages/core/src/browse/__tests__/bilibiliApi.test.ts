import { describe, expect, it } from 'vitest'
import {
  BilibiliResponseError,
  formatDuration,
  normalizeBvid,
  parseDuration,
  parseSearch,
  parseVideoInfo,
  searchUrl,
  videoInfoUrl,
  videoPagesUrl
} from '../bilibiliApi'

const SEARCH_BVID = 'BV1xx411c7mD'

describe('地址构造', () => {
  it('视频详情地址', () => {
    expect(videoInfoUrl(SEARCH_BVID)).toContain(`bvid=${SEARCH_BVID}`)
  })

  it('从完整链接里取 BV 号', () => {
    expect(normalizeBvid(`https://www.bilibili.com/video/${SEARCH_BVID}?p=1`)).toBe(SEARCH_BVID)
  })

  it('裸 BV 号直接用', () => {
    expect(normalizeBvid(SEARCH_BVID)).toBe(SEARCH_BVID)
  })

  it('av 号提示换接口', () => {
    expect(() => normalizeBvid('170001')).toThrow(/av 号/)
  })

  it('认不出的输入报错', () => {
    expect(() => normalizeBvid('随便什么')).toThrow(/认不出/)
  })

  it('分 P 地址二选一', () => {
    expect(videoPagesUrl({ bvid: SEARCH_BVID })).toContain('bvid=')
    expect(videoPagesUrl({ aid: 42 })).toContain('aid=42')
    expect(() => videoPagesUrl({})).toThrow()
  })

  it('搜索地址带页码', () => {
    const url = searchUrl('示例', 2)
    expect(url).toContain('page=2')
    expect(url).toContain(encodeURIComponent('示例'))
  })

  it('空搜索词报错', () => {
    expect(() => searchUrl('   ')).toThrow()
  })
})

describe('时长', () => {
  it('分:秒', () => {
    expect(parseDuration('12:34')).toBe(754)
  })

  it('时:分:秒', () => {
    expect(parseDuration('1:02:03')).toBe(3723)
  })

  it('坏格式返回 0', () => {
    expect(parseDuration('abc')).toBe(0)
  })

  it('秒转回文本', () => {
    expect(formatDuration(754)).toBe('12:34')
    expect(formatDuration(3723)).toBe('1:02:03')
    expect(formatDuration(0)).toBe('0:00')
  })

  it('负数不出现负号', () => {
    expect(formatDuration(-5)).toBe('0:00')
  })
})

describe('视频详情解析', () => {
  const payload = {
    code: 0,
    data: {
      bvid: SEARCH_BVID,
      aid: 123,
      title: '一个视频',
      pic: 'http://i0.hdslb.com/a.jpg',
      desc: '简介',
      duration: 300,
      pubdate: 1700000000,
      owner: { name: 'UP 主', mid: 9 },
      stat: { view: 1000, danmaku: 20, like: 50, coin: 10, favorite: 30, share: 5 },
      pages: [{ page: 1, part: '第一集', duration: 150 }]
    }
  }

  it('取出主要字段', () => {
    const info = parseVideoInfo(payload)
    expect(info.bvid).toBe(SEARCH_BVID)
    expect(info.title).toBe('一个视频')
    expect(info.author).toBe('UP 主')
    expect(info.duration).toBe(300)
  })

  it('统计数字齐全', () => {
    const info = parseVideoInfo(payload)
    expect(info.stats).toEqual({
      view: 1000,
      danmaku: 20,
      like: 50,
      coin: 10,
      favorite: 30,
      share: 5
    })
  })

  it('分 P 列表被解析', () => {
    const info = parseVideoInfo(payload)
    expect(info.pages).toHaveLength(1)
    expect(info.pages[0]?.title).toBe('第一集')
  })

  it('缺字段时给默认值，不炸', () => {
    const info = parseVideoInfo({ code: 0, data: { bvid: 'x' } })
    expect(info.title).toBe('')
    expect(info.stats.view).toBe(0)
    expect(info.pages).toEqual([])
  })

  it('业务错误码抛错', () => {
    expect(() => parseVideoInfo({ code: -404, message: '啥都木有' })).toThrow(
      BilibiliResponseError
    )
  })

  it('错误里带原始 message', () => {
    try {
      parseVideoInfo({ code: -404, message: '啥都木有' })
    } catch (error) {
      expect((error as BilibiliResponseError).code).toBe(-404)
      expect((error as Error).message).toContain('啥都木有')
    }
  })
})

describe('搜索结果解析', () => {
  const payload = {
    code: 0,
    data: {
      page: 1,
      numResults: 2,
      result: [
        {
          bvid: SEARCH_BVID,
          title: '标题里有 <em class="keyword">高亮</em>',
          author: 'UP',
          duration: '3:20',
          play: 888,
          pic: '//i0.hdslb.com/b.jpg'
        },
        {
          bvid: 'BV1yy411c7mE',
          title: '第二个 &amp; 转义',
          author: 'UP2',
          duration: '1:00:00',
          play: 1,
          pic: 'http://i0.hdslb.com/c.jpg'
        }
      ]
    }
  }

  it('条目数正确', () => {
    expect(parseSearch(payload).items).toHaveLength(2)
  })

  it('高亮标签被剥掉', () => {
    expect(parseSearch(payload).items[0]?.title).toBe('标题里有 高亮')
  })

  it('HTML 实体被还原', () => {
    expect(parseSearch(payload).items[1]?.title).toBe('第二个 & 转义')
  })

  it('时长转成秒', () => {
    expect(parseSearch(payload).items[0]?.duration).toBe(200)
    expect(parseSearch(payload).items[1]?.duration).toBe(3600)
  })

  it('封面补上协议', () => {
    expect(parseSearch(payload).items[0]?.cover).toBe('https://i0.hdslb.com/b.jpg')
  })

  it('空结果不报错', () => {
    const result = parseSearch({ code: 0, data: { page: 1, numResults: 0, result: [] } })
    expect(result.items).toEqual([])
    expect(result.total).toBe(0)
  })
})
