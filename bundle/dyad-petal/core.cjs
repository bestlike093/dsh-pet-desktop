'use strict'

/**
 * 由 scripts/build-petal-core.mjs 从 core.mjs 生成，不要手改。
 * 需要改动时改 core.mjs，然后跑 `pnpm petal:build`。
 */

const ID = 'dyad.pet'
const VERSION = '0.1.0'

const state = {
  host: null,
  boots: 0,
  calls: 0
}

function describe() {
  return { id: ID, version: VERSION, dualHost: true }
}

function greet(name) {
  state.calls += 1
  return `hello, ${String(name === undefined || name === null ? 'world' : name)}`
}

function markHost(host) {
  state.host = String(host)
  state.boots += 1
  return state.host
}

function snapshot() {
  return { host: state.host, boots: state.boots, calls: state.calls }
}

const core = { ID, VERSION, describe, greet, markHost, snapshot }

module.exports = { ID, VERSION, describe, greet, markHost, snapshot, core }
