/**
 * 双宿主共享内核 · 唯一真源。
 *
 * 只放与宿主无关的纯逻辑。两个入口各自适配生命周期：
 * Cyrene 用 register/unregister，dsh 用 bootstrap/teardown。
 * 内核本身不认任何一种，避免把某一侧的形状带进另一侧。
 *
 * core.cjs 由 scripts/build-petal-core.mjs 生成，不要手改。
 * 改这里，然后跑 `pnpm petal:build`。
 */

export const ID = 'dyad.pet'
export const VERSION = '0.1.0'

const state = {
  host: null,
  boots: 0,
  calls: 0
}

export function describe() {
  return { id: ID, version: VERSION, dualHost: true }
}

export function greet(name) {
  state.calls += 1
  return `hello, ${String(name === undefined || name === null ? 'world' : name)}`
}

export function markHost(host) {
  state.host = String(host)
  state.boots += 1
  return state.host
}

export function snapshot() {
  return { host: state.host, boots: state.boots, calls: state.calls }
}

export const core = { ID, VERSION, describe, greet, markHost, snapshot }
