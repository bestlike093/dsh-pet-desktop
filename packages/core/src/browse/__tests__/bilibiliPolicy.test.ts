import { describe, expect, it } from 'vitest'
import {
  DEFAULT_BILIBILI_POLICY,
  MAX_COIN_COUNT,
  READ_ONLY_ACTIONS,
  WRITE_ACTIONS,
  WRITE_ACTION_META,
  BilibiliCoinLimitError,
  BilibiliReadOnlyError,
  BilibiliWriteDisabledError,
  assertActionAllowed,
  assertCoinCount,
  needsConfirmation
} from '../bilibili'
import type { BilibiliPolicy, BilibiliWriteAction } from '../bilibili'

function policy(enabled: readonly BilibiliWriteAction[], maxCoins = 1): BilibiliPolicy {
  return { enabledWrites: enabled, maxCoinsPerAction: maxCoins }
}

describe('B 站策略：默认纯只读', () => {
  it('默认策略没有开启任何写动作', () => {
    expect(DEFAULT_BILIBILI_POLICY.enabledWrites).toEqual([])
  })

  it('五个读动作默认全部放行', () => {
    for (const action of READ_ONLY_ACTIONS) {
      expect(() => assertActionAllowed(action, DEFAULT_BILIBILI_POLICY)).not.toThrow()
    }
  })

  it('五个写动作默认全部拒绝', () => {
    for (const action of WRITE_ACTIONS) {
      expect(() => assertActionAllowed(action, DEFAULT_BILIBILI_POLICY)).toThrow(
        BilibiliWriteDisabledError
      )
    }
  })

  it('拒绝信息里点明是哪个动作、叫什么', () => {
    let message = ''
    try {
      assertActionAllowed('coin', DEFAULT_BILIBILI_POLICY)
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toContain('coin')
    expect(message).toContain('投币')
    expect(message).toContain('未开启')
  })
})

describe('B 站策略：逐项开启', () => {
  it('只开点赞，点赞放行，投币仍拒', () => {
    const p = policy(['like'])
    expect(() => assertActionAllowed('like', p)).not.toThrow()
    expect(() => assertActionAllowed('coin', p)).toThrow(BilibiliWriteDisabledError)
  })

  it('开哪项就只放哪项，互不带动', () => {
    for (const enabled of WRITE_ACTIONS) {
      const p = policy([enabled])
      for (const other of WRITE_ACTIONS) {
        if (other === enabled) continue
        expect(() => assertActionAllowed(other, p)).toThrow(BilibiliWriteDisabledError)
      }
    }
  })

  it('全开之后五个都能过', () => {
    const p = policy(WRITE_ACTIONS)
    for (const action of WRITE_ACTIONS) {
      expect(() => assertActionAllowed(action, p)).not.toThrow()
    }
  })

  it('未知动作既不是读也不是写，直接拒', () => {
    expect(() => assertActionAllowed('delete-video', policy(WRITE_ACTIONS))).toThrow(
      BilibiliReadOnlyError
    )
  })
})

describe('B 站策略：投币数量', () => {
  it('默认上限 1 枚，投 1 枚通过', () => {
    expect(() => assertCoinCount(1, DEFAULT_BILIBILI_POLICY)).not.toThrow()
  })

  it('默认上限下投 2 枚被拒', () => {
    expect(() => assertCoinCount(2, DEFAULT_BILIBILI_POLICY)).toThrow(BilibiliCoinLimitError)
  })

  it('把上限调到 2 后可以投 2 枚', () => {
    expect(() => assertCoinCount(2, policy(['coin'], 2))).not.toThrow()
  })

  it('策略写 5 也不会真放开到 5，硬顶是 2', () => {
    expect(() => assertCoinCount(3, policy(['coin'], 5))).toThrow(BilibiliCoinLimitError)
    expect(MAX_COIN_COUNT).toBe(2)
  })

  it('0 枚、负数、小数都拒', () => {
    for (const count of [0, -1, 1.5]) {
      expect(() => assertCoinCount(count, policy(['coin'], 2))).toThrow(BilibiliCoinLimitError)
    }
  })

  it('报错里带上请求值和实际上限', () => {
    let message = ''
    try {
      assertCoinCount(5, policy(['coin'], 2))
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toContain('5')
    expect(message).toContain('2')
  })
})

describe('B 站策略：哪些动作要二次确认', () => {
  it('点赞、收藏不需要确认', () => {
    expect(needsConfirmation('like')).toBe(false)
    expect(needsConfirmation('favorite')).toBe(false)
  })

  it('评论、转发、投币需要确认', () => {
    expect(needsConfirmation('comment')).toBe(true)
    expect(needsConfirmation('share')).toBe(true)
    expect(needsConfirmation('coin')).toBe(true)
  })

  it('投币标记为消耗资产且不可撤回', () => {
    expect(WRITE_ACTION_META.coin.costly).toBe(true)
    expect(WRITE_ACTION_META.coin.reversible).toBe(false)
  })

  it('评论标记为公开', () => {
    expect(WRITE_ACTION_META.comment.public).toBe(true)
  })

  it('每个写动作都有元信息，标签不为空', () => {
    for (const action of WRITE_ACTIONS) {
      expect(WRITE_ACTION_META[action].label.length).toBeGreaterThan(0)
    }
  })
})
