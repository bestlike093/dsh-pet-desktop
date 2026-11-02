import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { HostProbeError } from '@pet/shared'
import type { HostCapability } from '@pet/shared'
import { LocalHostAdapter } from '../LocalHostAdapter.js'

const INSTALL_DIR = join('C:', 'fake', 'DeepSeek Harness')
const VERSION_PATH = join(INSTALL_DIR, 'resources', 'version')
const DECLARATION_PATH = join(INSTALL_DIR, 'resources', 'host-capabilities.json')

function fileMap(entries: Readonly<Record<string, string>>) {
  return async (path: string): Promise<string> => {
    const value = entries[path]
    if (value === undefined) throw new Error(`ENOENT: ${path}`)
    return value
  }
}

describe('LocalHostAdapter：探测失败必须可见（铁律 3）', () => {
  it('探测环境必失败时抛 HostProbeError，而不是返回空数组', async () => {
    const adapter = new LocalHostAdapter({
      installDir: INSTALL_DIR,
      readTextFile: async () => {
        throw new Error('权限被拒绝')
      }
    })

    await expect(adapter.detect()).rejects.toBeInstanceOf(HostProbeError)
  })

  it('定位不到安装目录时抛 HOST_NOT_FOUND', async () => {
    const adapter = new LocalHostAdapter({
      env: {},
      platform: 'win32'
    })

    await expect(adapter.detect()).rejects.toMatchObject({ code: 'HOST_NOT_FOUND' })
  })

  it('安装目录存在但版本文件缺失时抛 VERSION_UNREADABLE', async () => {
    const adapter = new LocalHostAdapter({
      installDir: INSTALL_DIR,
      readTextFile: fileMap({})
    })

    await expect(adapter.detect()).rejects.toMatchObject({ code: 'VERSION_UNREADABLE' })
  })

  it('能力声明不是合法 JSON 时抛 DECLARATION_INVALID', async () => {
    const adapter = new LocalHostAdapter({
      installDir: INSTALL_DIR,
      readTextFile: fileMap({
        [VERSION_PATH]: '0.2.1-rc.3\n',
        [DECLARATION_PATH]: '{ broken'
      })
    })

    await expect(adapter.detect()).rejects.toMatchObject({ code: 'DECLARATION_INVALID' })
  })
})

describe('LocalHostAdapter：成功路径', () => {
  it('读到版本与能力声明时返回快照，并更新 version', async () => {
    const adapter = new LocalHostAdapter({
      installDir: INSTALL_DIR,
      readTextFile: fileMap({
        [VERSION_PATH]: ' 0.2.1-rc.3 \n',
        // 故意含未知键：验证解析时忽略，不能收窄成 HostCapability。
        // 读取入口的契约本来就是 unknown（内容来自宿主 JSON），本用例不绕过任何类型检查，也不是可照抄的示例。
        [DECLARATION_PATH]: JSON.stringify({ available: ['ask', 'approval', 'unknown-key'] as const })
      })
    })

    const snapshot = await adapter.detect()

    expect(snapshot.version).toBe('0.2.1-rc.3')
    expect(snapshot.available).toEqual(['ask', 'approval'])
    expect(adapter.version).toBe('0.2.1-rc.3')
  })

  it('声明与安装包实据都拿不到时，返回零能力而不是报错', async () => {
    const adapter = new LocalHostAdapter({
      installDir: INSTALL_DIR,
      readTextFile: fileMap({ [VERSION_PATH]: '0.2.1-rc.3' })
    })

    const snapshot = await adapter.detect()

    expect(snapshot.available).toEqual([])
  })

  it('声明缺失时回落到 api-catalog 实据，不直接归零', async () => {
    const adapter = new LocalHostAdapter({
      installDir: INSTALL_DIR,
      readTextFile: fileMap({ [VERSION_PATH]: '0.2.1-rc.3' }),
      readApiCatalogKeys: async () => ['llm', 'sessions', 'skills']
    })

    const snapshot = await adapter.detect()

    expect(snapshot.available).toEqual(['llmCall', 'sessionRead', 'skillCatalog'])
  })

  it('声明存在时优先于 catalog，两套证据不混用', async () => {
    const adapter = new LocalHostAdapter({
      installDir: INSTALL_DIR,
      readTextFile: fileMap({
        [VERSION_PATH]: '0.2.1-rc.3',
        [DECLARATION_PATH]: JSON.stringify({
          available: ['ask'] as const satisfies readonly HostCapability[]
        })
      }),
      readApiCatalogKeys: async () => ['llm', 'sessions', 'skills']
    })

    const snapshot = await adapter.detect()

    expect(snapshot.available).toEqual(['ask'])
  })

  it('catalog 里缺某个 key 时，对应能力不点亮', async () => {
    const adapter = new LocalHostAdapter({
      installDir: INSTALL_DIR,
      readTextFile: fileMap({ [VERSION_PATH]: '0.2.1-rc.3' }),
      readApiCatalogKeys: async () => ['llm']
    })

    const snapshot = await adapter.detect()

    expect(snapshot.available).toEqual(['llmCall'])
  })

  it('版本文件缺失时回落到根目录 version', async () => {
    const adapter = new LocalHostAdapter({
      installDir: INSTALL_DIR,
      readTextFile: fileMap({ [join(INSTALL_DIR, 'version')]: '0.2.1-rc.3' })
    })

    await expect(adapter.detect()).resolves.toMatchObject({ version: '0.2.1-rc.3' })
  })
})
