import { describe, expect, it } from 'vitest'
import { ErrorCode, PetError } from '@pet/shared'
import { inspectUpload } from '../uploadGuard.js'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00])
const WEBM = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x00, 0x00])
const ZIP = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00])

function expectCode(fn: () => unknown, code: ErrorCode): void {
  try {
    fn()
  } catch (error) {
    expect(error).toBeInstanceOf(PetError)
    expect((error as PetError).code).toBe(code)
    return
  }
  throw new Error('预期抛出错误，实际没有')
}

describe('上传流水线第一步：MIME + 扩展名 + 魔数（S4）', () => {
  it('PNG 通过，归到 image', () => {
    const result = inspectUpload({
      fileName: 'portrait.png',
      declaredMime: 'image/png',
      head: PNG,
      size: 1024
    })

    expect(result.extension).toBe('.png')
    expect(result.mime).toBe('image/png')
    expect(result.kind).toBe('image')
  })

  it('png 改名 .gif → 魔数拦截（DoD ①）', () => {
    expectCode(
      () =>
        inspectUpload({
          fileName: 'renamed.gif',
          declaredMime: 'image/gif',
          head: PNG,
          size: 1024
        }),
      ErrorCode.ASSET_INVALID_MAGIC
    )
  })

  it('声明 MIME 与扩展名不一致 → 在魔数之前就拒', () => {
    expectCode(
      () =>
        inspectUpload({
          fileName: 'portrait.png',
          declaredMime: 'image/gif',
          head: PNG,
          size: 1024
        }),
      ErrorCode.MIME_MISMATCH
    )
  })

  it('不在白名单的扩展名一律拒', () => {
    for (const fileName of ['payload.svg', 'payload.html', 'payload.exe', 'payload.dll']) {
      expectCode(
        () =>
          inspectUpload({
            fileName,
            declaredMime: '',
            head: PNG,
            size: 1024
          }),
        ErrorCode.MIME_MISMATCH
      )
    }
  })

  it('WebM 与 ZIP 各有独立魔数', () => {
    expect(
      inspectUpload({ fileName: 'motion.webm', declaredMime: 'video/webm', head: WEBM, size: 2048 }).kind
    ).toBe('video')
    expect(
      inspectUpload({ fileName: 'model.zip', declaredMime: 'application/zip', head: ZIP, size: 2048 }).kind
    ).toBe('live2d')
  })

  it('超过该类型上限才拒，按类型区分', () => {
    expectCode(
      () =>
        inspectUpload({
          fileName: 'huge.png',
          declaredMime: 'image/png',
          head: PNG,
          size: 21 * 1024 * 1024
        }),
      ErrorCode.QUOTA_EXCEEDED
    )

    expect(
      inspectUpload({
        fileName: 'movie.mp4',
        declaredMime: 'video/mp4',
        head: new Uint8Array([0, 0, 0, 0, 0x66, 0x74, 0x79, 0x70]),
        size: 21 * 1024 * 1024
      }).kind
    ).toBe('video')
  })

  it('浏览器不给 MIME 时用扩展名 + 魔数兜底，不误伤 .moc', () => {
    const result = inspectUpload({
      fileName: 'model.moc',
      declaredMime: '',
      head: new Uint8Array([0x00, 0x01, 0x02]),
      size: 4096
    })

    expect(result.extension).toBe('.moc')
    expect(result.kind).toBe('live2d')
  })

  it('扩展名先小写归一：.PNG 与 .png 等价', () => {
    const result = inspectUpload({
      fileName: 'PORTRAIT.PNG',
      declaredMime: 'image/png',
      head: PNG,
      size: 1024
    })

    expect(result.extension).toBe('.png')
  })

  it('否定样本自证：明显不存在的 MIME 确实会被捕获', () => {
    expectCode(
      () =>
        inspectUpload({
          fileName: 'portrait.png',
          declaredMime: 'application/x-not-a-real-mime',
          head: PNG,
          size: 1024
        }),
      ErrorCode.MIME_MISMATCH
    )
  })
})
