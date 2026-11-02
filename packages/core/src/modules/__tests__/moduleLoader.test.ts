import { describe, expect, it } from 'vitest'
import type { IPetalModule } from '@pet/shared'
import { createRegistryModuleLoader } from '../moduleLoader.js'

function moduleOf(id: string, onTeardown?: () => void): IPetalModule {
  return {
    meta: { id, name: id, version: '1.0.0', permissions: [], tier: 'general' },
    async bootstrap() {},
    async teardown() {
      onTeardown?.()
    }
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('ModuleLoader：注册表式懒加载', () => {
  it('首次实例化，二次命中缓存', async () => {
    let created = 0
    const loader = createRegistryModuleLoader([
      [
        'a',
        () => {
          created += 1
          return moduleOf('a')
        }
      ]
    ])

    const first = await loader.load('a')
    const second = await loader.load('a')

    expect(created).toBe(1)
    expect(second).toBe(first)
    expect(loader.kind).toBe('registry')
    expect(loader.has('a')).toBe(true)
    expect(loader.size).toBe(1)
  })

  it('并发 load 同一个 id 只实例化一次', async () => {
    let created = 0
    const loader = createRegistryModuleLoader([
      [
        'a',
        async () => {
          created += 1
          return moduleOf('a')
        }
      ]
    ])

    const [first, second] = await Promise.all([loader.load('a'), loader.load('a')])

    expect(created).toBe(1)
    expect(second).toBe(first)
  })

  it('未知 id 抛 LOAD_FAILED', async () => {
    const loader = createRegistryModuleLoader([])

    await expect(loader.load('missing')).rejects.toMatchObject({ code: 'LOAD_FAILED' })
  })

  it('实例化抛错不写入缓存，下一次可以重试', async () => {
    let attempt = 0
    const loader = createRegistryModuleLoader([
      [
        'flaky',
        () => {
          attempt += 1
          if (attempt === 1) throw new Error('boom')
          return moduleOf('flaky')
        }
      ]
    ])

    await expect(loader.load('flaky')).rejects.toThrow('boom')
    const module = await loader.load('flaky')

    expect(attempt).toBe(2)
    expect(module.meta.id).toBe('flaky')
  })
})

describe('ModuleLoader：真超时与悬挂资源清理', () => {
  it('超时抛 LOAD_TIMEOUT', async () => {
    const loader = createRegistryModuleLoader([['slow', () => new Promise<IPetalModule>(() => {})]], {
      timeoutMs: 20
    })

    await expect(loader.load('slow')).rejects.toMatchObject({ code: 'LOAD_TIMEOUT' })
  })

  it('超时后迟到的模块会被 teardown，不留悬挂资源', async () => {
    const gate = deferred<IPetalModule>()
    let tornDown = false
    const loader = createRegistryModuleLoader([['slow', () => gate.promise]], { timeoutMs: 20 })

    await expect(loader.load('slow')).rejects.toMatchObject({ code: 'LOAD_TIMEOUT' })

    gate.resolve(moduleOf('slow', () => {
      tornDown = true
    }))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(tornDown).toBe(true)
  })

  it('外部 signal 取消后，迟到模块同样被清理', async () => {
    const gate = deferred<IPetalModule>()
    let tornDown = false
    const controller = new AbortController()
    const loader = createRegistryModuleLoader([['slow', () => gate.promise]], { timeoutMs: 5_000 })

    const pending = loader.load('slow', { signal: controller.signal })
    controller.abort()

    await expect(pending).rejects.toMatchObject({ code: 'LOAD_FAILED' })

    gate.resolve(moduleOf('slow', () => {
      tornDown = true
    }))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(tornDown).toBe(true)
  })

  it('超时之后可以重新加载成功', async () => {
    let attempt = 0
    const loader = createRegistryModuleLoader(
      [
        [
          'slow',
          () => {
            attempt += 1
            if (attempt === 1) return new Promise<IPetalModule>(() => {})
            return moduleOf('slow')
          }
        ]
      ],
      { timeoutMs: 20 }
    )

    await expect(loader.load('slow')).rejects.toMatchObject({ code: 'LOAD_TIMEOUT' })
    const module = await loader.load('slow')

    expect(module.meta.id).toBe('slow')
    expect(attempt).toBe(2)
  })
})

describe('ModuleLoader：epoch 作废迟到结果', () => {
  it('超时后迟到的模块不写缓存，下一次 load 仍走源', async () => {
    let created = 0
    let lateTornDown = 0
    const gate = deferred<IPetalModule>()
    const loader = createRegistryModuleLoader(
      [
        [
          'slow',
          () => {
            created += 1
            if (created === 1) return gate.promise
            return moduleOf('slow')
          }
        ]
      ],
      { timeoutMs: 20 }
    )

    await expect(loader.load('slow')).rejects.toMatchObject({ code: 'LOAD_TIMEOUT' })

    gate.resolve(
      moduleOf('slow', () => {
        lateTornDown += 1
      })
    )
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(lateTornDown).toBe(1)

    const module = await loader.load('slow')
    expect(created).toBe(2)
    expect(module.meta.id).toBe('slow')
  })

  it('旧 epoch 的迟到结果不会覆盖新一轮成功结果', async () => {
    let created = 0
    const first = deferred<IPetalModule>()
    const second = deferred<IPetalModule>()
    const loader = createRegistryModuleLoader(
      [
        [
          'slow',
          () => {
            created += 1
            return created === 1 ? first.promise : second.promise
          }
        ]
      ],
      { timeoutMs: 20 }
    )

    await expect(loader.load('slow')).rejects.toMatchObject({ code: 'LOAD_TIMEOUT' })

    const retry = loader.load('slow')
    const fresh = moduleOf('slow')
    second.resolve(fresh)
    expect(await retry).toBe(fresh)

    // 第一轮的迟到结果此时才回来，必须被丢弃，不能顶掉 fresh
    first.resolve(moduleOf('slow'))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(await loader.load('slow')).toBe(fresh)
  })

  it('迟到结果不注册：has 保持 false，缓存不落地', async () => {
    const gate = deferred<IPetalModule>()
    let created = 0
    const loader = createRegistryModuleLoader(
      [
        [
          'slow',
          () => {
            created += 1
            if (created === 1) return gate.promise
            return moduleOf('slow')
          }
        ]
      ],
      { timeoutMs: 20 }
    )

    await expect(loader.load('slow')).rejects.toMatchObject({ code: 'LOAD_TIMEOUT' })
    expect(loader.has('slow')).toBe(false)

    gate.resolve(moduleOf('slow'))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(loader.has('slow')).toBe(false)
    expect(loader.size).toBe(0)
  })

  it('迟到结果不 attach：bootstrap 一次都没触发，只做清理', async () => {
    const gate = deferred<IPetalModule>()
    let booted = 0
    let tornDown = 0
    let created = 0
    const late: IPetalModule = {
      meta: { id: 'slow', name: 'slow', version: '1.0.0', permissions: [], tier: 'general' },
      async bootstrap() {
        booted += 1
      },
      async teardown() {
        tornDown += 1
      }
    }
    const loader = createRegistryModuleLoader(
      [
        [
          'slow',
          () => {
            created += 1
            return created === 1 ? gate.promise : moduleOf('slow')
          }
        ]
      ],
      { timeoutMs: 20 }
    )

    await expect(loader.load('slow')).rejects.toMatchObject({ code: 'LOAD_TIMEOUT' })
    gate.resolve(late)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(booted).toBe(0)
    expect(tornDown).toBe(1)
  })

  it('disposeQuietly 静默：teardown 抛错也不淹没 LOAD_TIMEOUT', async () => {
    const gate = deferred<IPetalModule>()
    let created = 0
    const loader = createRegistryModuleLoader(
      [
        [
          'slow',
          () => {
            created += 1
            if (created === 1) return gate.promise
            return moduleOf('slow')
          }
        ]
      ],
      { timeoutMs: 20 }
    )

    await expect(loader.load('slow')).rejects.toMatchObject({ code: 'LOAD_TIMEOUT' })

    gate.resolve(
      moduleOf('slow', () => {
        throw new Error('teardown boom')
      })
    )
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(loader.has('slow')).toBe(false)
  })
})
