#!/usr/bin/env node
/**
 * 契约快照提取器自测。
 *
 * 守卫本身也要被验证覆盖：提取器出问题时表现为「静默少记」，
 * 契约快照照样报 OK，但实际没看那些成员。所以这些 fixture 必须常驻。
 *
 * 覆盖三类历史盲区 + 一类常见写法：
 * 1. 泛型约束里带对象字面量（`T extends { id: string }`）；
 * 2. union 中间夹注释；
 * 3. 箭头函数返回类型（`() => Promise<void>`）；
 * 4. 多行泛型参数。
 */

import { extractDeclarations } from './lib/contract-extract.mjs'

let failed = 0

function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`)
  if (!ok) {
    failed += 1
    if (detail !== undefined) console.log(`     ${detail}`)
  }
}

const generic = `export interface Port<T extends { readonly id: string }> {
  run(value: T): void
  stop(): void
}
`
const genericSig = extractDeclarations(generic).get('Port') ?? ''
check(
  '泛型约束带对象字面量：记录全部成员',
  genericSig.includes('run(value: T): void') && genericSig.includes('stop(): void'),
  `实际：${genericSig}`
)

const union = `export type Code =
  | 'A'
  | 'B'
  /** 中间注释 */
  | 'C'
`
const unionSig = extractDeclarations(union).get('Code') ?? ''
check(
  'union 中间夹注释：不截断',
  unionSig.includes("'A'") && unionSig.includes("'B'") && unionSig.includes("'C'"),
  `实际：${unionSig}`
)

const arrow = `export interface Handle {
  readonly commit: () => Promise<void>
  close(): void
}
`
const arrowSig = extractDeclarations(arrow).get('Handle') ?? ''
check(
  '箭头函数返回类型：不截断',
  arrowSig.includes('commit: () => Promise<void>') && arrowSig.includes('close(): void'),
  `实际：${arrowSig}`
)

const multi = `export interface Store<
  T extends { readonly id: string }
> {
  get(id: string): T
}
`
const multiSig = extractDeclarations(multi).get('Store') ?? ''
check('多行泛型参数：记录成员', multiSig.includes('get(id: string): T'), `实际：${multiSig}`)

console.log('')
if (failed === 0) {
  console.log('CONTRACT_GUARD_OK')
  process.exit(0)
}
console.log(`CONTRACT_GUARD_FAILED_${failed}`)
process.exit(1)
