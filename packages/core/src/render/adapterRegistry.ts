import { ErrorCode, PetError } from '@pet/shared'
import type { IModel, ModelKind, SizeProfile, SpriteSheet } from '@pet/shared'

export interface AdapterContext {
  readonly id: string
  readonly source: string
  readonly profile: SizeProfile
  /** 像素比，供适配器决定内部画布尺寸 */
  readonly dpr: number
  /** 已解析的帧序列描述；仅 sprite 适配器读取，其他适配器忽略。 */
  readonly spriteSheet?: SpriteSheet
}

export interface ModelAdapter {
  readonly kind: ModelKind
  create(context: AdapterContext): IModel
}

/** 适配器注册表：按媒体类型分派，未知类型给出稳定错误码。 */
export class AdapterRegistry {
  private readonly adapters = new Map<ModelKind, ModelAdapter>()

  register(adapter: ModelAdapter, options: { replace?: boolean } = {}): void {
    if (this.adapters.has(adapter.kind) && options.replace !== true) {
      throw new PetError(ErrorCode.INVALID_ARGUMENT, `适配器已注册：${adapter.kind}`)
    }
    this.adapters.set(adapter.kind, adapter)
  }

  unregister(kind: ModelKind): boolean {
    return this.adapters.delete(kind)
  }

  has(kind: ModelKind): boolean {
    return this.adapters.has(kind)
  }

  kinds(): readonly ModelKind[] {
    return [...this.adapters.keys()]
  }

  create(kind: ModelKind, context: AdapterContext): IModel {
    const adapter = this.adapters.get(kind)
    if (adapter === undefined) {
      throw new PetError(ErrorCode.MODEL_NOT_RENDERABLE, `没有可用的渲染适配器：${kind}`, {
        details: { kind, available: this.kinds() }
      })
    }
    return adapter.create(context)
  }
}
