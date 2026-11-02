import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Live2D 事故回归：模型包里写的是 Texture_01.png，代码里写成 texture_01.png。
// Windows 上两种写法指向同一文件，Linux 上是两个文件 —— 这就是 CI 必须跑双平台的原因。
//
// 这条断言测的是「宿主环境前提」，不是业务逻辑；业务侧的大小写语义由
// zipExtractor 的 toLowerCase() 判重覆盖（见 zipExtractor.test.ts「大小写重复条目名」）。
// 两个分支都写死各自的平台语义，没有 it.skip —— 平台变了就会红。

const isWindows = process.platform === 'win32'

describe('文件系统大小写语义', () => {
  it('同名不同大小写在 Windows 指同一文件、在 Linux 指不同文件', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-case-'))
    try {
      writeFileSync(join(dir, 'Texture_01.png'), 'x')
      const lower = join(dir, 'texture_01.png')

      if (isWindows) {
        // NTFS 默认不区分大小写：r+ 能打开，说明命中了同一个文件
        expect(() => writeFileSync(lower, 'y', { flag: 'r+' })).not.toThrow()
      } else {
        // ext4/APFS(区分大小写卷) 上是两个文件，r+ 必然 ENOENT
        expect(() => writeFileSync(lower, 'y', { flag: 'r+' })).toThrow()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
