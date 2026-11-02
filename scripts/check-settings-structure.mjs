#!/usr/bin/env node
/**
 * 设置窗结构校验。
 *
 * 设置页是一个纯静态 HTML + 手写 JS 的组合，没有框架兜底，改名、删节点都不会报错，
 * 只会在运行时安静地失效（$('x') 返回 null，事件绑不上）。这里在 CI 前先把三类坑拦住：
 *
 *   1. 重复 id —— 浏览器只认第一个，第二个永远是死的
 *   2. settings.js 引用了 HTML 里不存在的 id —— 改名漏改
 *   3. 导航项 data-panel 没有对应的面板容器 —— 点了没反应
 *
 * 用法：node scripts/check-settings-structure.mjs
 */

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const rendererDir = path.join(root, 'apps', 'desktop', 'electron', 'renderer')

const html = await readFile(path.join(rendererDir, 'settings.html'), 'utf8')
const js = await readFile(path.join(rendererDir, 'settings.js'), 'utf8')

const problems = []

// ---- 1. HTML 里的 id：收集 + 查重 ----
const htmlIds = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1])
const idSet = new Set()
const duplicated = new Set()
for (const id of htmlIds) {
  if (idSet.has(id)) duplicated.add(id)
  idSet.add(id)
}
for (const id of duplicated) problems.push(`重复 id：${id}`)

// ---- 2. settings.js 引用到的 id 必须存在 ----
const referenced = new Set()
for (const pattern of [/\$\('([A-Za-z][\w-]*)'\)/g, /getElementById\('([A-Za-z][\w-]*)'\)/g]) {
  for (const match of js.matchAll(pattern)) referenced.add(match[1])
}
for (const id of referenced) {
  if (!idSet.has(id)) problems.push(`settings.js 引用了不存在的 id：${id}`)
}

// ---- 3. 导航项与面板容器对得上 ----
const navPanels = [...html.matchAll(/<button[^>]*data-panel="([^"]+)"/g)].map((match) => match[1])
const panelContainers = new Set(
  [...html.matchAll(/class="panel[^"]*"[^>]*data-panel="([^"]+)"/g)].map((match) => match[1])
)
for (const panel of new Set(navPanels)) {
  if (!panelContainers.has(panel)) problems.push(`导航项 data-panel="${panel}" 没有对应面板容器`)
}
if (navPanels.length === 0) problems.push('没有找到任何导航项（<button data-panel=…>）')

if (problems.length > 0) {
  console.error('SETTINGS_STRUCTURE_FAILED')
  for (const problem of problems) console.error(` - ${problem}`)
  process.exit(1)
}

console.log(
  `SETTINGS_STRUCTURE_OK ${htmlIds.length} ids / ${referenced.size} refs / ` +
    `${new Set(navPanels).size} panels`
)
