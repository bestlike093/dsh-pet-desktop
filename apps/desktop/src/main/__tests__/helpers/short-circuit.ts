import { expect } from 'vitest'

/**
 * 短路律：任何在探测前就该返回的分支，都不该留下副作用。
 *
 * 计数器必须同步、在同一微任务窗口取值：调用方传 () => number，断言前后
 * 不得 await，不得 debounce、批采集或定时 flush。chat 探活若走异步分支，
 * 被延后累加的差值会在下一次 flush 前读成 0，漏判成「没有副作用」。
 */
export const shortCircuit = {
  toHoldFor(channel: string, calls: () => number): void {
    expect(calls(), `违反短路律：${channel} 的短路分支产生了副作用`).toBe(0)
  }
}
