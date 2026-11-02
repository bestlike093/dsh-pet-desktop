/**
 * 三端口共用的调用链骨架（S7-b）。
 *
 * push 的唯一出口是 `publish()`：
 * - `apply()` 校验通过后只调用 `publish()` 一次，不再调 `broadcast()`；
 * - `broadcast()` 只是「手动再发一次全量」的入口，内部转调 `publish()`。
 *
 * 任何一条绕开 `publish()` 的推送路径都会让「换一次主题推两遍」重新出现，
 * 因此测试断言的是 publish 的调用次数，不是订阅端收到了几次。
 */

import {
  ErrorCode,
  PetError,
  type IPresentationPortV1,
  type IPresentationPublisherV1,
  type TokenPatchV1,
  type ValidationResultV1
} from '@pet/shared'

export abstract class PresentationPortBase<T extends { readonly id: string }>
  implements IPresentationPortV1<T>
{
  private readonly registry = new Map<string, T>()
  private currentValue: T | undefined
  /** 换肤事务：一次 apply / broadcast 一个标识，用来区分「一次发多次」与「多次各发一次」。 */
  private transaction = 'standalone'
  private seq = 0

  constructor(
    protected readonly publisher: IPresentationPublisherV1,
    /** 默认不打印；需要取证时由装配方注入，避免污染测试输出。 */
    private readonly logPublish: (line: string) => void = () => {}
  ) {}

  /** 把一个配置对象摊成点分路径的字符串载荷；weight 之类数字必须先 String()。 */
  protected abstract toPatch(value: T): TokenPatchV1

  /** 同步、纯函数、不抛错；必须遍历完所有字段，不得短路。 */
  abstract validate(value: T): ValidationResultV1

  abstract describeTokens(): readonly string[]

  /** 供 describeTokens 使用：未 apply 时返回 undefined，而不是抛错。 */
  protected currentOrUndefined(): T | undefined {
    return this.currentValue
  }

  async publish(patch: TokenPatchV1): Promise<void> {
    this.logPublish(`publish tx=${this.transaction} keys=${Object.keys(patch).length}`)
    await this.publisher.publish(patch)
  }

  async broadcast(): Promise<void> {
    this.transaction = `broadcast-${++this.seq}`
    await this.publish(this.toPatch(this.requireCurrent()))
  }

  async apply(value: T): Promise<void> {
    this.assertValid(value)
    this.currentValue = value
    this.transaction = `apply-${++this.seq}`
    await this.publish(this.toPatch(value))
  }

  async register(value: T): Promise<void> {
    this.assertValid(value)
    this.registry.set(value.id, value)
  }

  async unregister(id: string): Promise<void> {
    this.registry.delete(id)
  }

  list(): readonly T[] {
    return [...this.registry.values()]
  }

  current(): T {
    return this.requireCurrent()
  }

  private assertValid(value: T): void {
    const result = this.validate(value)
    if (!result.ok) {
      throw new PetError(ErrorCode.INVALID_ARGUMENT, '表现层配置校验失败', {
        details: { errors: result.errors }
      })
    }
  }

  private requireCurrent(): T {
    if (this.currentValue === undefined) {
      throw new PetError(ErrorCode.NOT_REGISTERED, '尚未应用任何配置')
    }
    return this.currentValue
  }
}
