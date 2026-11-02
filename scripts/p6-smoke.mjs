// P6 冒烟：诊断面板、依赖方向与体积门禁
import { fileURLToPath } from 'node:url'
import { buildDiagnosticsPanel, formatDiagnosticsPanel } from '../packages/core/dist/index.js'
import { checkDependencies, formatBytes, walkSize } from './lib/gate.mjs'

let failed = 0
function check(name, ok, extra = '') {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : ''))
  if (!ok) failed += 1
}

// 1. 诊断面板
const snapshot = {
  version: '2.0.0-dev.0',
  generatedAt: 1_700_000_000_000,
  ok: false,
  bridge: 'not-connected',
  sections: [
    { name: 'render', ok: true, data: { fps: 60 } },
    { name: 'vault', ok: false, code: 'VAULT_LOCKED', message: '仓库未解锁' }
  ]
}
const panel = buildDiagnosticsPanel(snapshot, { render: '渲染', vault: '仓库' })
check('panel: 行数含桥接', panel.rows.length === 3)
check('panel: 正常项为 ok', panel.rows.find((row) => row.id === 'render').level === 'ok')
check('panel: 失败项为 error', panel.rows.find((row) => row.id === 'vault').level === 'error')
check(
  'panel: 失败详情带错误码',
  panel.rows.find((row) => row.id === 'vault').detail.includes('VAULT_LOCKED')
)
check('panel: 未连接桥接为 warn', panel.rows.find((row) => row.id === 'bridge').level === 'warn')
check('panel: 整体不健康', panel.ok === false)
check('panel: 中文标签生效', panel.rows.find((row) => row.id === 'render').label === '渲染')

const text = formatDiagnosticsPanel(panel)
check('panel: 文本含错误标记', text.includes('[ERROR] 仓库'))
check('panel: 文本含时间', text.includes('2023-11-14'))
check('panel: 文本含标题', text.includes('桌宠诊断'))

const emptyPanel = buildDiagnosticsPanel({
  version: '2.0.0-dev.0',
  generatedAt: 1_700_000_000_000,
  ok: true,
  bridge: 'connected',
  sections: []
})
check('panel: 空数据源给 warn', emptyPanel.rows[0].level === 'warn')
check('panel: 桥接已连接为 ok', emptyPanel.rows.find((row) => row.id === 'bridge').level === 'ok')

const healthy = buildDiagnosticsPanel({ ...snapshot, bridge: 'connected', sections: [snapshot.sections[0]] })
check('panel: 无错误时整体健康', healthy.ok === true)

// 2. 依赖方向
const validManifests = {
  'packages/shared': { dependencies: {} },
  'packages/core': { dependencies: { '@pet/shared': 'workspace:*' } },
  'packages/vault': { dependencies: { '@pet/shared': 'workspace:*' } },
  'packages/memory': { dependencies: { '@pet/shared': 'workspace:*' } },
  'apps/desktop': {
    dependencies: {
      '@pet/shared': 'workspace:*',
      '@pet/core': 'workspace:*',
      '@pet/vault': 'workspace:*'
    }
  }
}
check('gate: 合法依赖通过', checkDependencies(validManifests).ok === true)

const sharedToCore = checkDependencies({
  ...validManifests,
  'packages/shared': { dependencies: { '@pet/core': 'workspace:*' } }
})
check('gate: shared 反向依赖被拒', sharedToCore.ok === false && sharedToCore.violations[0].includes('shared'))

const coreToVault = checkDependencies({
  ...validManifests,
  'packages/core': { dependencies: { '@pet/shared': 'workspace:*', '@pet/vault': 'workspace:*' } }
})
check('gate: core 依赖 vault 被拒', coreToVault.ok === false)

const externalDep = checkDependencies({
  ...validManifests,
  'packages/vault': { dependencies: { '@pet/shared': 'workspace:*', lodash: '^4.0.0' } }
})
check('gate: 外部运行时依赖被拒', externalDep.ok === false && externalDep.violations.some((item) => item.includes('lodash')))

const missing = checkDependencies({
  'packages/shared': {},
  'packages/core': {},
  'packages/vault': {},
  'apps/desktop': {}
})
check('gate: 缺内部依赖被拒', missing.ok === false)

// 3. 体积统计
const scriptsSize = walkSize(fileURLToPath(new URL('.', import.meta.url)))
check('size: 能统计文件数', scriptsSize.files > 0 && scriptsSize.bytes > 0)
check('size: 记录最大文件', scriptsSize.largest.bytes > 0)
check('size: 字节格式化', formatBytes(1024) === '1.0 KiB' && formatBytes(2 * 1024 * 1024) === '2.00 MiB')

console.log('\nP6_SMOKE_' + (failed === 0 ? 'OK' : 'FAILED_' + failed))
process.exit(failed === 0 ? 0 : 1)
