import { describe, expect, it } from 'vitest'
import {
  SubagentError,
  SubagentScheduler,
  type SubagentTask
} from '../subagent'
import { enabledServers, mergeTools, parseServerConfig, qualifyToolName } from '../mcp'

function task(
  id: string,
  companionId: string,
  kind: 'read-only' | 'write' = 'read-only'
): SubagentTask {
  return { id, companionId, kind, input: {} }
}

describe('子任务调度', () => {
  it('派出去后占用一个名额', () => {
    const s = new SubagentScheduler()
    s.claim(task('t1', 'fengjin'))
    expect(s.activeCount).toBe(1)
  })

  it('同一角色复用上下文', () => {
    const s = new SubagentScheduler()
    s.claim(task('t1', 'fengjin'))
    const second = s.claim(task('t2', 'fengjin'))
    expect(second.reused).toBe(true)
    expect(s.historyOf('fengjin')).toEqual(['t1', 't2'])
  })

  it('不同角色各自独立', () => {
    const s = new SubagentScheduler()
    s.claim(task('t1', 'fengjin'))
    const second = s.claim(task('t2', 'changye'))
    expect(second.reused).toBe(false)
  })

  it('重复的任务 id 被拒', () => {
    const s = new SubagentScheduler()
    s.claim(task('t1', 'a'))
    expect(() => s.claim(task('t1', 'b'))).toThrow(SubagentError)
  })

  it('只读任务有并发上限', () => {
    const s = new SubagentScheduler({ maxConcurrentRead: 2 })
    s.claim(task('t1', 'a'))
    s.claim(task('t2', 'b'))
    expect(() => s.claim(task('t3', 'c'))).toThrow(SubagentError)
  })

  it('写入任务独占，已有只读时被拒', () => {
    const s = new SubagentScheduler()
    s.claim(task('t1', 'a'))
    expect(() => s.claim(task('t2', 'b', 'write'))).toThrow(SubagentError)
  })

  it('写入任务进行中时只读也要等', () => {
    const s = new SubagentScheduler()
    s.claim(task('w1', 'a', 'write'))
    expect(() => s.claim(task('t2', 'b'))).toThrow(SubagentError)
  })

  it('两个写入任务不能同时跑', () => {
    const s = new SubagentScheduler()
    s.claim(task('w1', 'a', 'write'))
    expect(() => s.claim(task('w2', 'b', 'write'))).toThrow(SubagentError)
  })

  it('结束后名额释放', () => {
    const s = new SubagentScheduler()
    s.claim(task('t1', 'a'))
    s.finish('t1')
    expect(s.activeCount).toBe(0)
    expect(() => s.claim(task('t2', 'b'))).not.toThrow()
  })

  it('关闭角色后不能继续派活', () => {
    const s = new SubagentScheduler()
    s.claim(task('t1', 'a'))
    s.finish('t1')
    s.close('a')
    expect(s.isOpen('a')).toBe(false)
    expect(() => s.claim(task('t2', 'a'))).toThrow(SubagentError)
  })

  it('关闭角色会释放它占的名额', () => {
    const s = new SubagentScheduler()
    s.claim(task('t1', 'a'))
    s.close('a')
    expect(s.activeCount).toBe(0)
  })

  it('没开过的角色 close 不报错', () => {
    const s = new SubagentScheduler()
    expect(() => s.close('nobody')).not.toThrow()
  })

  it('把任务按只读并行、写入独占切批', () => {
    const s = new SubagentScheduler({ maxConcurrentRead: 2 })
    const batches = s.plan([
      task('a', 'x'),
      task('b', 'y'),
      task('c', 'z'),
      task('w', 'x', 'write'),
      task('d', 'y')
    ])

    expect(batches).toHaveLength(4)
    expect(batches[0]?.map((t) => t.id)).toEqual(['a', 'b'])
    expect(batches[1]?.map((t) => t.id)).toEqual(['c'])
    expect(batches[2]?.map((t) => t.id)).toEqual(['w'])
    expect(batches[3]?.map((t) => t.id)).toEqual(['d'])
  })

  it('预算按步数算', () => {
    const s = new SubagentScheduler({ defaultBudget: 10 })
    const t = task('t1', 'a')
    expect(s.overBudget(t, 9)).toBe(false)
    expect(s.overBudget(t, 10)).toBe(true)
  })

  it('任务可以自带预算', () => {
    const s = new SubagentScheduler({ defaultBudget: 10 })
    expect(s.overBudget({ ...task('t1', 'a'), budget: 3 }, 3)).toBe(true)
  })
})

describe('MCP 配置', () => {
  const good = {
    mcpServers: {
      fs: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem'], env: { ROOT: 'C:/' } }
    }
  }

  it('解析标准写法', () => {
    const result = parseServerConfig(good)
    expect(result.issues).toEqual([])
    expect(result.servers).toHaveLength(1)
    expect(result.servers[0]?.command).toBe('npx')
    expect(result.servers[0]?.env.ROOT).toBe('C:/')
  })

  it('也接受去掉外层包裹的写法', () => {
    const result = parseServerConfig({ fs: { command: 'node', args: [] } })
    expect(result.servers).toHaveLength(1)
  })

  it('坏 JSON 只报一条错', () => {
    const result = parseServerConfig('{not json')
    expect(result.servers).toEqual([])
    expect(result.issues[0]?.field).toBe('json')
  })

  it('缺 command 的项被挑出来，其他照常', () => {
    const result = parseServerConfig({
      mcpServers: {
        bad: { args: [] },
        good: { command: 'node' }
      }
    })
    expect(result.servers.map((s) => s.id)).toEqual(['good'])
    expect(result.issues[0]?.serverId).toBe('bad')
    expect(result.issues[0]?.field).toBe('command')
  })

  it('args 不是字符串数组时报错', () => {
    const result = parseServerConfig({ mcpServers: { a: { command: 'x', args: [1, 2] } } })
    expect(result.servers).toEqual([])
    expect(result.issues[0]?.field).toBe('args')
  })

  it('默认启用，显式 false 才关', () => {
    const result = parseServerConfig({
      mcpServers: {
        a: { command: 'x' },
        b: { command: 'y', enabled: false }
      }
    })
    expect(enabledServers(result.servers).map((s) => s.id)).toEqual(['a'])
  })

  it('env 里的非字符串值被丢掉', () => {
    const result = parseServerConfig({
      mcpServers: { a: { command: 'x', env: { N: 1, S: 'ok' } } }
    })
    expect(result.servers[0]?.env).toEqual({ S: 'ok' })
  })
})

describe('MCP 工具合并', () => {
  it('加命名空间避免撞名', () => {
    expect(qualifyToolName('fs', 'read')).toBe('fs__read')
  })

  it('非法字符被洗掉', () => {
    expect(qualifyToolName('my-server', 'read file')).toBe('my_server__read_file')
  })

  it('两个 server 的同名工具都保留', () => {
    const merged = mergeTools([
      [{ serverId: 'a', name: 'search' }],
      [{ serverId: 'b', name: 'search' }]
    ])
    expect(merged.tools.map((t) => t.qualifiedName)).toEqual(['a__search', 'b__search'])
    expect(merged.collisions).toEqual([])
  })

  it('同一 server 内重名只留第一个', () => {
    const merged = mergeTools([
      [
        { serverId: 'a', name: 'search', description: '第一次' },
        { serverId: 'a', name: 'search', description: '第二次' }
      ]
    ])
    expect(merged.tools).toHaveLength(1)
    expect(merged.collisions).toEqual(['a__search'])
  })

  it('描述被带过去', () => {
    const merged = mergeTools([[{ serverId: 'a', name: 't', description: '说明' }]])
    expect(merged.tools[0]?.description).toBe('说明')
  })

  it('空清单不报错', () => {
    expect(mergeTools([]).tools).toEqual([])
  })
})
