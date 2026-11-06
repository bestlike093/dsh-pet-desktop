'use strict'

/**
 * Cyrene 入口。
 * Cyrene 插件导出形态是 register(ctx) / unregister()。
 */

const fs = require('node:fs')
const path = require('node:path')
const core = require('./core.cjs')

/**
 * 加载痕迹：重启后能确认插件真的被宿主执行过。
 * 只写时间戳与版本，不含任何用户数据。
 */
function record(line) {
  try {
    const dir = path.join(process.env.APPDATA || '', 'Cyrene')
    fs.appendFileSync(
      path.join(dir, 'dyad-pet.marker'),
      `${new Date().toISOString()} ${line} v${core.VERSION}\n`,
      'utf8'
    )
  } catch (error) {
    // 痕迹写不了不影响加载
  }
}

const plugin = {
  apiVersion: 1,
  id: core.ID,

  register(ctx) {
    core.markHost('cyrene')
    record('register')
    try {
      if (ctx && typeof ctx.log === 'function') {
        ctx.log(`[${core.ID}] register v${core.VERSION}`)
      }
    } catch (error) {
      // 日志通道异常不能把插件判成加载失败
    }
  },

  unregister() {
    core.markHost('cyrene-unregister')
    record('unregister')
  }
}

module.exports = plugin
module.exports.default = plugin
