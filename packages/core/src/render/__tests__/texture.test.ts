import { describe, expect, it } from 'vitest'
import { findFirstTexture } from '../texture.js'

const file = (name: string, text = '') => ({ name, text: async () => text })
const manifest = (value: unknown) => file('model.model3.json', JSON.stringify(value))

/**
 * 【保留 · 前期不实现 · 依赖 E4/E8】
 *
 * 这组测试本身在跑，覆盖的是清单字段解析（纯函数）。
 * ⚠️ 它不证明 Live2D 渲染路径可用：真实 Cubism 4 模型的端到端加载
 * 从未发生过。E4/E8 到位时才真正生效，届时需要补一次真机冒烟。
 *
 * ⛔ 不得因为「跑不通」删除。
 */
describe('C1 回归：findFirstTexture 两种清单格式', () => {
  it('Cubism 4 官方格式 FileReferences.Textures', async () => {
    const hit = await findFirstTexture(manifest({ FileReferences: { Textures: ['a/tex.png'] } }), [
      file('TEX.PNG')
    ])
    expect(hit?.name).toBe('TEX.PNG')
  })

  it('旧自检格式扁平 textures，反斜杠路径只取文件名', async () => {
    const hit = await findFirstTexture(manifest({ textures: ['dir\\skin.png'] }), [
      file('skin.png')
    ])
    expect(hit?.name).toBe('skin.png')
  })

  it('两种格式同时存在时官方格式优先', async () => {
    const model = manifest({
      FileReferences: { Textures: ['official.png'] },
      textures: ['legacy.png']
    })
    const hit = await findFirstTexture(model, [file('official.png'), file('legacy.png')])
    expect(hit?.name).toBe('official.png')
  })

  it('纹理名对不上时回退到第一张图片', async () => {
    const hit = await findFirstTexture(manifest({ textures: ['missing.png'] }), [
      file('readme.txt'),
      file('fallback.webp')
    ])
    expect(hit?.name).toBe('fallback.webp')
  })

  it('清单没有纹理时返回 null，不做图片回退', async () => {
    const hit = await findFirstTexture(manifest({}), [file('fallback.webp')])
    expect(hit).toBeNull()
  })

  it('清单损坏返回 null，不抛错', async () => {
    await expect(findFirstTexture(file('bad.model3.json', '{not json'), [])).resolves.toBeNull()
  })

  it('纹理与图片都不存在时返回 null', async () => {
    await expect(findFirstTexture(manifest({}), [file('a.txt')])).resolves.toBeNull()
  })
})
