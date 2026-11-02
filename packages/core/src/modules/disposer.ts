import type { DisposerRegistry } from '@pet/shared'

/** 逆序释放：后注册的先拆，符合资源依赖方向。单个释放失败不阻断其余清理。 */
export function createDisposerRegistry(): DisposerRegistry {
  const disposers: Array<() => void> = []
  return {
    add(fn: () => void): void {
      disposers.push(fn)
    },
    disposeAll(): void {
      while (disposers.length > 0) {
        const fn = disposers.pop()
        if (fn === undefined) continue
        try {
          fn()
        } catch {
          // 单个释放失败不阻断其余清理
        }
      }
    }
  }
}
