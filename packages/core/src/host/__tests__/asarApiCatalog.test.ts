import { describe, expect, it } from 'vitest'
import {
  API_CATALOG_ENTRY,
  extractServiceApiKeys,
  locateEntry,
  readApiCatalogKeys,
  readApiCatalogText
} from '../asarApiCatalog.js'

/** 按 asar 头部格式拼一个最小包：16 字节头 + 对齐后的 JSON 目录 + 数据区。 */
function buildAsar(entryPath: string, content: string): Buffer {
  const parts = entryPath.split('/')
  const tree: { files: Record<string, unknown> } = { files: {} }

  let cursor = tree
  parts.forEach((part, index) => {
    const isLeaf = index === parts.length - 1
    const node: Record<string, unknown> = isLeaf
      ? { size: Buffer.byteLength(content), offset: 0 }
      : { files: {} }
    cursor.files[part] = node
    if (!isLeaf) cursor = node as typeof tree
  })

  const json = Buffer.from(JSON.stringify(tree), 'utf8')
  const padding = (4 - (json.length % 4)) % 4
  const header = Buffer.concat([json, Buffer.alloc(padding)])

  const prefix = Buffer.alloc(16)
  prefix.writeUInt32LE(4, 0)
  prefix.writeUInt32LE(8 + header.length, 4)
  prefix.writeUInt32LE(4 + header.length, 8)
  prefix.writeUInt32LE(header.length, 12)

  return Buffer.concat([prefix, header, Buffer.from(content, 'utf8')])
}

describe('asar 能力实据：从安装包里读 SERVICE_API', () => {
  it('定位到目录树里的文件并取出原文', () => {
    const content = "export const SERVICE_API = [\n        key: 'llm',\n];\n"
    const buffer = buildAsar(API_CATALOG_ENTRY, content)

    const entry = locateEntry(buffer)
    expect(entry).toBeDefined()
    expect(buffer.subarray(entry!.offset, entry!.offset + entry!.size).toString('utf8')).toBe(content)
  })

  it('目录里没有目标文件时返回 undefined，不抛异常', () => {
    expect(locateEntry(buildAsar('other/file.js', 'x'))).toBeUndefined()
    expect(locateEntry(Buffer.alloc(8))).toBeUndefined()
    expect(locateEntry(Buffer.from('not an asar at all'))).toBeUndefined()
  })

  it('只扫 SERVICE_API 段，不误抓事件表里的 key', () => {
    const text = [
      "export const SERVICE_API = [",
      "        key: 'llm',",
      "        key: 'sessions',",
      "];",
      "export const HARNESS_EVENTS = [",
      "        key: 'shouldNotAppear',",
      "];"
    ].join('\n')

    expect(extractServiceApiKeys(text)).toEqual(['llm', 'sessions'])
  })

  it('读不到安装包时返回 undefined', async () => {
    await expect(readApiCatalogKeys('C:\\nowhere')).resolves.toBeUndefined()
  })

  it('注入字节读取器时完整走通', async () => {
    const content = "export const SERVICE_API = [\n        key: 'fs',\n        key: 'web',\n];\n"
    const buffer = buildAsar(API_CATALOG_ENTRY, content)

    await expect(readApiCatalogText('C:\\fake', async () => buffer)).resolves.toContain('SERVICE_API')
    await expect(readApiCatalogKeys('C:\\fake', async () => buffer)).resolves.toEqual(['fs', 'web'])
  })
})
