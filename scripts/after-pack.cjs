// electron-builder afterPack 钩子：把 workspace 包的 dist + manifest 落到包内。
//
// 源侧 @pet/* 是 pnpm Junction，electron-builder 不跟随，所以由本钩子复制。
// 复制是「单来源、双落点、单硬落点」：源只有 packages/<name>，包内需要两个 sink。
//
// sinkA（SOFT，缺了由 sinkB 兜住）← apps/desktop/dist/*.js
//   hostAdapter.js              → import '@pet/core'
//   ipc.js                      → import '@pet/shared'
//   remote/qqOfficialChannel.js → import '@pet/shared'
//   windowShell.js              → import '@pet/shared'
//   解析链：apps/desktop/dist/ 向上
//     → apps/desktop/node_modules/@pet/<name>   ← 本钩子写入
//     →（若缺）app/node_modules/@pet/<name>      ← 回落到 sinkB，仍可启动
//
// sinkB（HARD，缺了必崩）← packages/*/dist/**/*.js
//   main.mjs 用相对路径加载 packages/core/dist/index.js
//   → packages/core/dist/assets/assetManager.js → import '@pet/shared'
//   解析链：packages/core/dist/assets/ 向上
//     → packages/core/dist/node_modules（无）
//     → packages/core/node_modules（无）
//     → packages/node_modules（无）
//     → app/node_modules/@pet/<name>            ← 本钩子写入，唯一硬依赖
//
// 删减冒烟（2026-11-02 实测）：
//   删 sinkA（SOFT）→ 从 apps/desktop/dist 解析 @pet/core 仍 RESOLVED（回落 sinkB）
//   删 sinkB（HARD）→ 从 packages/core/dist/assets 解析 @pet/shared → MODULE_NOT_FOUND
//   因此 check-package 断言两处都在，并分别标 HARD / SOFT；sinkB 缺失必须失败。
//
// ⚠️ 只复制 package.json 与 dist/，不带 src / node_modules / 测试。

const fs = require('node:fs')
const path = require('node:path')

function copyPetPackages(projectDir, targetRoot, names) {
  const copied = []

  for (const name of names) {
    const srcPkg = path.join(projectDir, 'packages', name)
    if (!fs.existsSync(srcPkg)) {
      console.log(`[afterPack] 跳过 ${name}：packages/${name} 不存在`)
      continue
    }

    const destDir = path.join(targetRoot, name)
    fs.mkdirSync(destDir, { recursive: true })

    fs.copyFileSync(
      path.join(srcPkg, 'package.json'),
      path.join(destDir, 'package.json')
    )

    const srcDist = path.join(srcPkg, 'dist')
    if (fs.existsSync(srcDist)) {
      // ⚠️ 这里必须自己过滤 .map：cpSync 不读 electron-builder 的 files 排除规则，
      // 直接递归复制会把 tsc 生成的 sourcemap 一起塞进包（实测 880 个 / 2.09MB）。
      fs.cpSync(srcDist, path.join(destDir, 'dist'), {
        recursive: true,
        filter: (from) => !from.endsWith('.map')
      })
    }

    copied.push(name)
  }

  return copied
}

module.exports = async function afterPack(context) {
  const appOutDir = context.appOutDir
  const projectDir = context.packager.projectDir

  const linkDir = path.join(projectDir, 'apps', 'desktop', 'node_modules', '@pet')
  if (!fs.existsSync(linkDir)) {
    console.log('[afterPack] 源侧无 apps/desktop/node_modules/@pet，跳过')
    return
  }

  const names = fs.readdirSync(linkDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() || e.isSymbolicLink())
    .map((e) => e.name)

  const appRoot = path.join(appOutDir, 'resources', 'app')

  // 1) 给 apps/desktop/dist 用
  const desktopRoot = path.join(appRoot, 'apps', 'desktop', 'node_modules', '@pet')
  const copiedDesktop = copyPetPackages(projectDir, desktopRoot, names)
  console.log(`[afterPack] apps/desktop：${copiedDesktop.join(', ')}`)
  console.log(`[afterPack]   → ${desktopRoot}`)

  // 2) 给 packages/*/dist 用（主进程相对路径加载后的裸名解析）
  const appNodeModules = path.join(appRoot, 'node_modules', '@pet')
  const copiedApp = copyPetPackages(projectDir, appNodeModules, names)
  console.log(`[afterPack] app 根：${copiedApp.join(', ')}`)
  console.log(`[afterPack]   → ${appNodeModules}`)
}
