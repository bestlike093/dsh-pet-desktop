/**
 * 契约门禁自测夹具：故意只走依赖注入注册，验证扫描器不会漏掉这种形态。
 * 这个通道不进入 IPC_CHANNELS，也不参与运行时注册。
 */
export function registerFixtureChannel(deps: {
  registerChannel: (channel: string, listener: () => void) => void
}): void {
  deps.registerChannel('pet:fixture:deps-only', () => {})
}
