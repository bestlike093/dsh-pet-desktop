#!/usr/bin/env node
/**
 * 清空构建输出目录。
 *
 * 为什么需要：tsc 只增量写入，不删除上一次构建留下的产物。
 * 曾出现过 dist 里堆着上一轮的 __tests__ 与 .map（744 个文件 / 1.96 MiB），
 * 体积门禁因此长期红着。每次构建前先清干净，dist 就只反映当前这轮配置。
 *
 * 用法：node ../../scripts/clean-dist.mjs dist
 */
import { rmSync } from 'node:fs'
import { resolve } from 'node:path'

const target = resolve(process.cwd(), process.argv[2] ?? 'dist')
rmSync(target, { recursive: true, force: true })
