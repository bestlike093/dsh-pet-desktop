// 第三方声明门禁：依赖清单 ↔ THIRD-PARTY-NOTICES.md ↔ 实际 license 三方对齐。
// 用法：node scripts/check-third-party.mjs
// 退出码：0 通过 / 1 失败
//
// 为什么要读 node_modules：只核对文档会变成「文档说 MIT，实际没人看过」。
// 读不到实际 license 时直接失败，不按「大概是 MIT」放行。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const noticesPath = path.join(root, 'THIRD-PARTY-NOTICES.md')

let failed = 0
function check(ok, label, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failed += 1
}

check(fs.existsSync(noticesPath), 'THIRD-PARTY-NOTICES.md 存在')
const notices = fs.existsSync(noticesPath) ? fs.readFileSync(noticesPath, 'utf8') : ''

const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }
const names = Object.keys(deps).sort()
check(names.length > 0, '根 package.json 有依赖')

for (const name of names) {
  const metaPath = path.join(root, 'node_modules', ...name.split('/'), 'package.json')
  let license = ''
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'))
    license = typeof meta.license === 'string' ? meta.license : ''
  } catch {
    license = ''
  }

  check(license !== '', `${name} 能读到实际 license`, metaPath)
  check(notices.includes(name), `${name} 已列在声明里`)
  check(
    license !== '' && notices.includes(license),
    `${name} 的许可证与声明一致`,
    license || '未知'
  )
}

if (failed > 0) {
  console.log(`THIRD_PARTY_FAIL ${failed} 项`)
  process.exit(1)
}
console.log(`THIRD_PARTY_OK ${names.length} 个依赖`)
