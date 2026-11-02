type AnyRecord = Record<string, any>

/**
 * 外部服务密钥写通道：set / clear。
 *
 * 生命周期只有一条线：磁盘是唯一真相。
 * - `VaultServiceSecretStore` 没有内存缓存、没有 TTL；每次 set/clear 都是
 *   `load → 改 → save`，进程内明文只在 get 的返回值里短暂存在。
 * - clear 先判断 key 是否存在，不存在时不写盘、不审计；save 失败时磁盘仍是旧值。
 * - 重启后由 `new VaultServiceSecretStore(vault)` 从加密文件重建，不存在
 *   「内存已清、磁盘还在」的中间态。
 *
 * 已知限制：set / clear 是整文件 read-modify-write，并发写不同 service 时
 * 后写者可能基于旧快照覆盖前者。当前调用方是设置页单次点击，暂不加锁。
 */
export interface SecretChannelDeps {
  registerChannel: (channel: string, listener: (...args: any[]) => unknown) => void
  requireSecretStore: () => {
    set: (serviceId: string, value: string, field?: string) => Promise<void>
    clear: (serviceId: string, field?: string) => Promise<void>
  }
  /**
   * 某个服务的凭据落盘后通知宿主。
   * 通道连接持有的是解密后的旧值，必须在写入后重建才能用上新 AppSecret。
   */
  onSecretChanged?: (serviceId: string) => void
}

/** 与 main 里的原实现一致：请求必须是对象，field 为空字符串时按默认字段处理。 */
function serviceArgs(request: AnyRecord): { serviceId: string; field?: string } {
  if (typeof request !== 'object' || request === null) {
    throw new Error('请求必须是对象')
  }
  const serviceId = String(request.serviceId ?? '')
  const field = typeof request.field === 'string' && request.field.length > 0 ? request.field : undefined
  return { serviceId, field }
}

export function registerSecretChannels(deps: SecretChannelDeps): void {
  const register = deps.registerChannel

  register('pet:secrets:set', async (_event, request) => {
    const { serviceId, field } = serviceArgs(request as AnyRecord)
    const value = typeof request?.value === 'string' ? request.value : ''
    if (value.trim().length === 0) throw new Error('密钥不能为空')
    // 明文只在本行入参里出现一次；store 内部再 trim 并整文件加密落盘。
    await deps.requireSecretStore().set(serviceId, value.trim(), field)
    deps.onSecretChanged?.(serviceId)
    return { ok: true }
  })

  register('pet:secrets:clear', async (_event, request) => {
    const { serviceId, field } = serviceArgs(request as AnyRecord)
    await deps.requireSecretStore().clear(serviceId, field)
    deps.onSecretChanged?.(serviceId)
    return { ok: true }
  })
}
