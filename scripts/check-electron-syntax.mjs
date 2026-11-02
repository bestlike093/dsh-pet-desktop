#!/usr/bin/env node
/**
 * 桌面壳语法门禁。
 *
 * 为什么需要：`apps/desktop/electron/**` 既不进 tsc，也没有任何测试 import 它。
 * 于是「同一个标识符导入一次、又本地声明一次」这种错误可以让 verify 全绿，
 * 而应用一启动就是 SyntaxError。这个脚本只做 node --check，不执行代码。
 */
import { execFile } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const electronRoot = path.join(root, 'apps', 'desktop', 'electron')
const EXTENSIONS = new Set(['.mjs', '.cjs', '.js'])
/** 第三方代码不归我们管，也不该被语法门禁误伤。 */
const SKIP_DIRS = new Set(['node_modules', 'vendor'])

async function collect(dir, found = []) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return found
    throw error
  }

  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      await collect(full, found)
      continue
    }
    if (EXTENSIONS.has(path.extname(entry.name))) found.push(full)
  }
  return found
}

function checkSyntax(file) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ['--check', file], (error, _stdout, stderr) => {
      if (error === null) {
        resolve()
        return
      }
      const relative = path.relative(root, file).replaceAll('\\', '/')
      reject(new Error(`${relative}\n${stderr.trim()}`))
    })
  })
}

const files = (await collect(electronRoot)).sort()
const failures = []

for (const file of files) {
  try {
    await checkSyntax(file)
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error))
  }
}

if (failures.length > 0) {
  console.error(`ELECTRON_SYNTAX_FAIL ${failures.length}/${files.length}`)
  for (const failure of failures) console.error(`\n${failure}`)
  process.exit(1)
}

console.log(`ELECTRON_SYNTAX_OK ${files.length} files`)
