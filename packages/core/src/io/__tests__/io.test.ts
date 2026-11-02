import { describe, expect, it } from 'vitest'
import {
  PathRejectedError,
  assertRelativePath,
  extensionFor,
  filenameFromUrl,
  sanitizeFilename
} from '../pathSafety'
import {
  FileExistsError,
  FileTooLargeError,
  writeFenced,
  type FileWriterPort
} from '../fileWrite'
import { DownloadRejectedError, downloadToFence, type BinaryFetch } from '../download'

function memoryPort(): {
  port: FileWriterPort
  files: Map<string, Uint8Array>
  moves: Array<[string, string]>
} {
  const files = new Map<string, Uint8Array>()
  const moves: Array<[string, string]> = []
  const port: FileWriterPort = {
    write: async (path, data) => {
      files.set(path, data)
    },
    move: async (from, to) => {
      const data = files.get(from)
      if (data === undefined) throw new Error(`no such file: ${from}`)
      files.set(to, data)
      files.delete(from)
      moves.push([from, to])
    },
    remove: async (path) => {
      files.delete(path)
    },
    exists: async (path) => files.has(path)
  }
  return { port, files, moves }
}

describe('路径围栏', () => {
  it('普通相对路径通过', () => {
    expect(assertRelativePath('a/b/c.txt')).toBe('a/b/c.txt')
  })

  it('反斜杠统一成斜杠', () => {
    expect(assertRelativePath('a\\b\\c.txt')).toBe('a/b/c.txt')
  })

  it('拒绝绝对路径', () => {
    expect(() => assertRelativePath('/etc/passwd')).toThrow(PathRejectedError)
  })

  it('拒绝带盘符的路径', () => {
    expect(() => assertRelativePath('C:/Windows/x')).toThrow(PathRejectedError)
  })

  it('拒绝往上跳', () => {
    expect(() => assertRelativePath('a/../../x')).toThrow(PathRejectedError)
  })

  it('拒绝非法字符', () => {
    expect(() => assertRelativePath('a/b:c.txt')).toThrow(PathRejectedError)
  })

  it('空路径被拒', () => {
    expect(() => assertRelativePath('   ')).toThrow(PathRejectedError)
  })

  it('拒绝的路径不会漏到 root 之外', () => {
    try {
      assertRelativePath('../outside.txt', 'C:/root')
    } catch (error) {
      expect((error as PathRejectedError).reason).toBe('traversal')
    }
  })
})

describe('文件名清洗', () => {
  it('把非法字符换成下划线', () => {
    expect(sanitizeFilename('a:b*c?.txt')).toBe('a_b_c_.txt')
  })

  it('去掉结尾的点和空格', () => {
    expect(sanitizeFilename('report. ')).toBe('report')
  })

  it('空名用兜底', () => {
    expect(sanitizeFilename('', 'download')).toBe('download')
  })

  it('Windows 保留名加前缀', () => {
    expect(sanitizeFilename('CON.txt')).toBe('_CON.txt')
    expect(sanitizeFilename('com1')).toBe('_com1')
  })

  it('超长名被截断但保留扩展名', () => {
    const name = `${'a'.repeat(300)}.txt`
    const out = sanitizeFilename(name)
    expect(out.length).toBeLessThanOrEqual(200)
    expect(out.endsWith('.txt')).toBe(true)
  })
})

describe('文件名推断', () => {
  it('从 URL 取最后一段', () => {
    expect(filenameFromUrl('https://x.test/a/report.pdf')).toBe('report.pdf')
  })

  it('URL 解码', () => {
    expect(filenameFromUrl('https://x.test/%E6%8A%A5%E5%91%8A.pdf')).toBe('报告.pdf')
  })

  it('没扩展名时按 Content-Type 补', () => {
    expect(filenameFromUrl('https://x.test/image', 'image/png')).toBe('image.png')
  })

  it('猜不到类型就不加扩展名', () => {
    expect(filenameFromUrl('https://x.test/thing', 'application/octet-stream')).toBe('thing')
  })

  it('常见类型映射', () => {
    expect(extensionFor('image/jpeg')).toBe('.jpg')
    expect(extensionFor('application/pdf; charset=binary')).toBe('.pdf')
    expect(extensionFor(undefined)).toBe('')
  })
})

describe('围栏内写入', () => {
  const data = new Uint8Array([1, 2, 3])

  it('写入后能读到，返回相对路径', async () => {
    const { port, files } = memoryPort()
    const result = await writeFenced(port, 'C:/root', 'docs/a.bin', data)
    expect(result.relativePath).toBe('docs/a.bin')
    expect(result.bytes).toBe(3)
    expect(files.get('C:/root/docs/a.bin')).toEqual(data)
  })

  it('走临时文件再改名', async () => {
    const { port, moves } = memoryPort()
    await writeFenced(port, 'C:/root', 'a.bin', data)
    expect(moves).toHaveLength(1)
    expect(moves[0]?.[0]).toContain('.tmp-')
    expect(moves[0]?.[1]).toBe('C:/root/a.bin')
  })

  it('超过上限直接拒绝，不写任何东西', async () => {
    const { port, files } = memoryPort()
    await expect(
      writeFenced(port, 'C:/root', 'a.bin', new Uint8Array(100), { maxBytes: 10 })
    ).rejects.toBeInstanceOf(FileTooLargeError)
    expect(files.size).toBe(0)
  })

  it('重名时默认报错', async () => {
    const { port } = memoryPort()
    await writeFenced(port, 'C:/root', 'a.bin', data)
    await expect(writeFenced(port, 'C:/root', 'a.bin', data)).rejects.toBeInstanceOf(FileExistsError)
  })

  it('重名时可改为加序号', async () => {
    const { port } = memoryPort()
    await writeFenced(port, 'C:/root', 'a.bin', data)
    const second = await writeFenced(port, 'C:/root', 'a.bin', data, { onExists: 'rename' })
    expect(second.relativePath).toBe('a-1.bin')
    expect(second.renamed).toBe(true)
  })

  it('重名时可覆盖', async () => {
    const { port, files } = memoryPort()
    await writeFenced(port, 'C:/root', 'a.bin', data)
    await writeFenced(port, 'C:/root', 'a.bin', new Uint8Array([9]), { onExists: 'overwrite' })
    expect(files.get('C:/root/a.bin')).toEqual(new Uint8Array([9]))
  })

  it('越界路径被拒', async () => {
    const { port } = memoryPort()
    await expect(writeFenced(port, 'C:/root', '../x.bin', data)).rejects.toBeInstanceOf(PathRejectedError)
  })
})

function fakeFetch(
  body: Uint8Array,
  init: { status?: number; contentType?: string; length?: number } = {}
): BinaryFetch {
  return async () => ({
    ok: (init.status ?? 200) < 400,
    status: init.status ?? 200,
    headers: {
      get: (name) => {
        const key = name.toLowerCase()
        if (key === 'content-type') return init.contentType ?? 'application/octet-stream'
        if (key === 'content-length') return String(init.length ?? body.byteLength)
        return null
      }
    },
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer
  })
}

describe('下载', () => {
  const body = new Uint8Array([1, 2, 3, 4])

  it('正常下载并落盘', async () => {
    const { port, files } = memoryPort()
    const result = await downloadToFence('https://x.test/a.bin', port, fakeFetch(body), 'C:/root')
    expect(result.relativePath).toBe('a.bin')
    expect(result.bytes).toBe(4)
    expect(files.get('C:/root/a.bin')).toEqual(body)
  })

  it('非 http 协议被拒', async () => {
    const { port } = memoryPort()
    await expect(
      downloadToFence('file:///etc/passwd', port, fakeFetch(body), 'C:/root')
    ).rejects.toBeInstanceOf(DownloadRejectedError)
  })

  it('HTTP 错误被拒', async () => {
    const { port } = memoryPort()
    await expect(
      downloadToFence('https://x.test/a', port, fakeFetch(body, { status: 404 }), 'C:/root')
    ).rejects.toBeInstanceOf(DownloadRejectedError)
  })

  it('声明体积超限时根本不下载', async () => {
    const { port } = memoryPort()
    await expect(
      downloadToFence('https://x.test/a', port, fakeFetch(body, { length: 999 }), 'C:/root', {
        maxBytes: 10
      })
    ).rejects.toBeInstanceOf(FileTooLargeError)
  })

  it('实际体积超限时也拦下', async () => {
    const { port, files } = memoryPort()
    const big = new Uint8Array(50)
    await expect(
      downloadToFence('https://x.test/a', port, fakeFetch(big, { length: 1 }), 'C:/root', {
        maxBytes: 10
      })
    ).rejects.toBeInstanceOf(FileTooLargeError)
    expect(files.size).toBe(0)
  })

  it('空内容被拒', async () => {
    const { port } = memoryPort()
    await expect(
      downloadToFence('https://x.test/a', port, fakeFetch(new Uint8Array(0)), 'C:/root')
    ).rejects.toBeInstanceOf(DownloadRejectedError)
  })

  it('重名默认加序号，不覆盖已有文件', async () => {
    const { port } = memoryPort()
    await downloadToFence('https://x.test/a.bin', port, fakeFetch(body), 'C:/root')
    const second = await downloadToFence('https://x.test/a.bin', port, fakeFetch(body), 'C:/root')
    expect(second.relativePath).toBe('a-1.bin')
  })

  it('可以指定文件名', async () => {
    const { port } = memoryPort()
    const result = await downloadToFence('https://x.test/zzz', port, fakeFetch(body), 'C:/root', {
      filename: '自定义.txt'
    })
    expect(result.relativePath).toBe('自定义.txt')
  })

  it('返回 Content-Type', async () => {
    const { port } = memoryPort()
    const result = await downloadToFence(
      'https://x.test/a',
      port,
      fakeFetch(body, { contentType: 'image/png' }),
      'C:/root'
    )
    expect(result.contentType).toBe('image/png')
  })
})
