/**
 * dsh 入口。
 * dsh 的模块形态是 { meta, bootstrap(ctx), teardown(), diagnose?() }。
 *
 * 只用 ESM：dsh 的 renderer 是 sandbox + nodeIntegration:false，.cjs 在里面加载不了。
 */

import { ID, VERSION, markHost, snapshot, core } from './core.mjs'

export const meta = {
  id: ID,
  name: 'Dyad Pet Probe',
  version: VERSION,
  permissions: [],
  tier: 'general'
}

export async function bootstrap(ctx) {
  markHost('dsh')
  try {
    if (ctx && typeof ctx.log === 'function') {
      ctx.log(`[${ID}] bootstrap v${VERSION}`)
    }
  } catch (error) {
    // 日志通道异常不能把模块判成启动失败
  }
}

export async function teardown() {
  markHost('dsh-teardown')
}

export async function diagnose() {
  return { ok: true, code: 'DYAD_PROBE_OK', details: snapshot() }
}

// 两种取法都给：import * as m 与 (await import()).default 都能拿到同一个对象。
const petalModule = { meta, bootstrap, teardown, diagnose }

export { core }
export default petalModule
