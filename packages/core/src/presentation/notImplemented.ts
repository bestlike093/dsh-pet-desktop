/**
 * 表现层三端口的 NOT_IMPLEMENTED 桩（S7-a）。
 *
 * 文档 10.1b：未实现的一律显式抛错，禁止静默返回空或默认值。
 * 任何针对这些桩的契约测试都应在构造上 FAIL —— 这个 FAIL 是「无人实现」的可见状态，
 * 不要为了让测试变绿而给它加默认返回。
 */

import {
  ErrorCode,
  PetError,
  type FontSourceV1,
  type IFontPortV1,
  type IPresentationPortV1,
  type IStylePortV1,
  type IThemePortV1,
  type ResolvedFontV1,
  type StyleTokensV1,
  type ThemeTokensV1,
  type TokenPatchV1,
  type ValidationResultV1
} from '@pet/shared'

function notImplemented(port: string, method: string): never {
  throw new PetError(ErrorCode.NOT_IMPLEMENTED, `${port}.${method} 尚未实现`, {
    details: { port, method }
  })
}

/** 三端口共同的桩行为；子类只提供端口名与特有成员。 */
abstract class PresentationPortStub<T extends { readonly id: string }>
  implements IPresentationPortV1<T>
{
  protected abstract readonly portName: string

  validate(_value: T): ValidationResultV1 {
    return notImplemented(this.portName, 'validate')
  }

  async publish(_patch: TokenPatchV1): Promise<void> {
    notImplemented(this.portName, 'publish')
  }

  async apply(_value: T): Promise<void> {
    notImplemented(this.portName, 'apply')
  }

  async register(_value: T): Promise<void> {
    notImplemented(this.portName, 'register')
  }

  async unregister(_id: string): Promise<void> {
    notImplemented(this.portName, 'unregister')
  }

  list(): readonly T[] {
    return notImplemented(this.portName, 'list')
  }

  current(): T {
    return notImplemented(this.portName, 'current')
  }

  async broadcast(): Promise<void> {
    notImplemented(this.portName, 'broadcast')
  }

  describeTokens(): readonly string[] {
    return notImplemented(this.portName, 'describeTokens')
  }
}

export class NotImplementedThemePort
  extends PresentationPortStub<ThemeTokensV1>
  implements IThemePortV1
{
  protected readonly portName = 'IThemePortV1'
}

export class NotImplementedStylePort
  extends PresentationPortStub<StyleTokensV1>
  implements IStylePortV1
{
  protected readonly portName = 'IStylePortV1'
}

export class NotImplementedFontPort
  extends PresentationPortStub<FontSourceV1>
  implements IFontPortV1
{
  protected readonly portName = 'IFontPortV1'

  resolve(_family: string, _weight: number): ResolvedFontV1 {
    return notImplemented(this.portName, 'resolve')
  }
}
