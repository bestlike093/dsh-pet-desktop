/** 生成与释放 blob URL 的最小能力，便于在测试里替换。 */
export interface BlobUrlFactory {
  create(blob: Blob | MediaSource): string
  revoke(url: string): void
}

export interface BlobUrlLedgerOptions {
  readonly factory?: BlobUrlFactory
}

function defaultFactory(): BlobUrlFactory {
  return {
    create: (blob) => URL.createObjectURL(blob),
    revoke: (url) => URL.revokeObjectURL(url)
  }
}

/**
 * blob URL 登记表。
 *
 * 逐处补 revoke 必漏，所以把「创建」和「释放」都收进同一张表：
 * - 只有登记过的 URL 会被 revoke，避免对旧 URL 二次释放；
 * - release 幂等，重复调用不会重复 revoke；
 * - liveCount 给测试与诊断看，切源 N 次后不应随 N 增长。
 */
export class BlobUrlLedger {
  private readonly factory: BlobUrlFactory
  private readonly live = new Set<string>()

  constructor(options: BlobUrlLedgerOptions = {}) {
    this.factory = options.factory ?? defaultFactory()
  }

  create(blob: Blob | MediaSource): string {
    const url = this.factory.create(blob)
    this.live.add(url)
    return url
  }

  /** 释放一个 URL。未登记或已释放的 URL 直接忽略。 */
  release(url: string): void {
    if (!this.live.delete(url)) return
    this.factory.revoke(url)
  }

  /** 释放当前所有 URL，用于整窗销毁。 */
  releaseAll(): void {
    for (const url of [...this.live]) this.release(url)
  }

  /** 释放并清空登记表；此后 liveCount 恒为 0。 */
  dispose(): void {
    this.releaseAll()
  }

  /** 仍在表中、尚未释放的数量。 */
  get liveCount(): number {
    return this.live.size
  }

  /** 该 URL 是否仍可安全引用（未被释放过）。 */
  isLive(url: string): boolean {
    return this.live.has(url)
  }
}
