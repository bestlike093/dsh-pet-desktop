import { describe, expect, it } from 'vitest'
import {
  ActionParamsError,
  buildActionRequest,
  parseActionResponse,
  performAction
} from '../bilibiliActions'
import { PostDraftError, buildPostRequest, checkDraft } from '../bilibiliPost'
import { MAX_POST_IMAGES, MAX_POST_LENGTH } from '../bilibiliPost'

const aid = 170001
const bvid = 'BV1xx411c7mD'

describe('点赞请求', () => {
  it('点赞', () => {
    const req = buildActionRequest('like', { video: { aid } })
    expect(req.form).toEqual({ aid: '170001', like: '1' })
    expect(req.requiresCsrf).toBe(true)
  })

  it('取消点赞', () => {
    const req = buildActionRequest('like', { video: { aid }, like: false })
    expect(req.form.like).toBe('0')
  })

  it('缺 aid 被拒', () => {
    expect(() => buildActionRequest('like', {})).toThrow(ActionParamsError)
  })

  it('aid 为 0 被拒', () => {
    expect(() => buildActionRequest('like', { video: { aid: 0 } })).toThrow(ActionParamsError)
  })
})

describe('投币请求', () => {
  it('默认一枚', () => {
    const req = buildActionRequest('coin', { video: { aid } })
    expect(req.form.multiply).toBe('1')
  })

  it('两枚可以', () => {
    expect(buildActionRequest('coin', { video: { aid }, coinCount: 2 }).form.multiply).toBe('2')
  })

  it('三枚被拒', () => {
    expect(() => buildActionRequest('coin', { video: { aid }, coinCount: 3 })).toThrow(
      ActionParamsError
    )
  })

  it('顺带点赞写进 select_like', () => {
    expect(
      buildActionRequest('coin', { video: { aid }, alsoLike: true }).form.select_like
    ).toBe('1')
  })
})

describe('收藏请求', () => {
  it('收藏到指定夹', () => {
    const req = buildActionRequest('favorite', { video: { aid }, addToFavorites: [1, 2] })
    expect(req.form.add_media_ids).toBe('1,2')
  })

  it('只取消时 add 为空', () => {
    const req = buildActionRequest('favorite', { video: { aid }, removeFromFavorites: [3] })
    expect(req.form.add_media_ids).toBe('')
    expect(req.form.del_media_ids).toBe('3')
  })

  it('两边都空被拒', () => {
    expect(() => buildActionRequest('favorite', { video: { aid } })).toThrow(ActionParamsError)
  })
})

describe('评论请求', () => {
  it('正常评论', () => {
    const req = buildActionRequest('comment', { video: { aid }, message: '好看' })
    expect(req.form.message).toBe('好看')
    expect(req.form.oid).toBe('170001')
  })

  it('空评论被拒', () => {
    expect(() => buildActionRequest('comment', { video: { aid }, message: '  ' })).toThrow(
      ActionParamsError
    )
  })

  it('超长被拒', () => {
    expect(() =>
      buildActionRequest('comment', { video: { aid }, message: 'a'.repeat(1001) })
    ).toThrow(ActionParamsError)
  })

  it('刚好一千字可以', () => {
    expect(() =>
      buildActionRequest('comment', { video: { aid }, message: 'a'.repeat(1000) })
    ).not.toThrow()
  })
})

describe('转发请求', () => {
  it('需要合法 BV 号', () => {
    expect(buildActionRequest('share', { video: { aid, bvid } }).form.bvid).toBe(bvid)
  })

  it('BV 号不对被拒', () => {
    expect(() => buildActionRequest('share', { video: { aid, bvid: 'BV123' } })).toThrow(
      ActionParamsError
    )
  })
})

describe('响应解析', () => {
  it('code 0 算成功', () => {
    expect(parseActionResponse({ code: 0 }).ok).toBe(true)
  })

  it('非 0 带出原始提示', () => {
    const res = parseActionResponse({ code: 65006, message: '已赞过' })
    expect(res.ok).toBe(false)
    expect(res.message).toBe('已赞过')
  })

  it('没有 message 时给默认提示', () => {
    expect(parseActionResponse({ code: 1 }).message).toContain('1')
  })

  it('非对象响应被拒', () => {
    expect(parseActionResponse(null).ok).toBe(false)
  })
})

describe('动作执行', () => {
  it('未开启直接返回失败，不拼请求', async () => {
    let sent = false
    const res = await performAction('like', { video: { aid } }, {
      allowed: () => false,
      send: async () => {
        sent = true
        return { code: 0 }
      }
    })
    expect(res.ok).toBe(false)
    expect(sent).toBe(false)
  })

  it('开启后发出请求并解析', async () => {
    const res = await performAction('like', { video: { aid } }, {
      allowed: () => true,
      send: async (req) => ({ code: req.form.like === '1' ? 0 : 1 })
    })
    expect(res.ok).toBe(true)
  })
})

describe('发动态', () => {
  it('正常草稿', () => {
    const req = buildPostRequest({ content: '今天也在写代码' })
    expect(req.requiresCsrf).toBe(true)
    expect(req.form.dyn_req).toContain('今天也在写代码')
  })

  it('空正文被拒', () => {
    expect(() => buildPostRequest({ content: '   ' })).toThrow(PostDraftError)
  })

  it('超长被拒', () => {
    expect(() => buildPostRequest({ content: 'a'.repeat(MAX_POST_LENGTH + 1) })).toThrow(
      PostDraftError
    )
  })

  it('刚好上限可以', () => {
    expect(() => buildPostRequest({ content: 'a'.repeat(MAX_POST_LENGTH) })).not.toThrow()
  })

  it('图片超过九张被拒', () => {
    const urls = Array.from({ length: MAX_POST_IMAGES + 1 }, (_, i) => `https://x.test/${i}.png`)
    expect(() => buildPostRequest({ content: 'x', imageUrls: urls })).toThrow(PostDraftError)
  })

  it('图片地址非法被拒', () => {
    expect(() => buildPostRequest({ content: 'x', imageUrls: ['not-a-url'] })).toThrow(
      PostDraftError
    )
  })

  it('checkDraft 不抛错，只回错误文案', () => {
    expect(checkDraft({ content: '' })).toHaveLength(1)
    expect(checkDraft({ content: 'ok' })).toEqual([])
  })
})
