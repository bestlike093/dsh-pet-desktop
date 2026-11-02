/**
 * MCP server 配置与工具清单。
 *
 * 这里不启动进程，只做两件容易出错的事：
 *
 * 1. 校验用户贴进来的配置，别等到 spawn 才报错
 * 2. 把多个 server 的工具合并成一张表，同名工具加命名空间
 *
 * 对应能力：`agent.mcp`。
 */

export interface McpServerConfig {
  readonly id: string
  readonly command: string
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
  readonly cwd?: string
  readonly enabled: boolean
}

export interface McpConfigIssue {
  readonly serverId: string
  readonly field: string
  readonly message: string
}

export interface ParseResult {
  readonly servers: readonly McpServerConfig[]
  readonly issues: readonly McpConfigIssue[]
}

/**
 * 解析 `mcpServers` 配置块。
 *
 * 支持 `{ "mcpServers": { ... } }` 和直接给 `{ ... }` 两种写法。
 * 坏掉的项进 `issues`，好的项照常返回——不让一条配置毁掉全部。
 */
export function parseServerConfig(input: string | object): ParseResult {
  const servers: McpServerConfig[] = []
  const issues: McpConfigIssue[] = []

  let raw: unknown = input
  if (typeof input === 'string') {
    try {
      raw = JSON.parse(input)
    } catch {
      return {
        servers: [],
        issues: [{ serverId: '*', field: 'json', message: '配置不是合法的 JSON' }]
      }
    }
  }

  if (raw === null || typeof raw !== 'object') {
    return {
      servers: [],
      issues: [{ serverId: '*', field: 'root', message: '配置必须是一个对象' }]
    }
  }

  const container = raw as Record<string, unknown>
  const table = (container.mcpServers ?? container) as unknown

  if (table === null || typeof table !== 'object' || Array.isArray(table)) {
    return {
      servers: [],
      issues: [{ serverId: '*', field: 'mcpServers', message: 'mcpServers 必须是对象' }]
    }
  }

  for (const [id, value] of Object.entries(table as Record<string, unknown>)) {
    const parsed = parseOne(id, value)
    if ('issue' in parsed) {
      issues.push(parsed.issue)
      continue
    }
    servers.push(parsed.server)
  }

  return { servers, issues }
}

function parseOne(
  id: string,
  value: unknown
): { server: McpServerConfig } | { issue: McpConfigIssue } {
  if (id.trim().length === 0) {
    return { issue: { serverId: id, field: 'id', message: 'server 名不能为空' } }
  }

  if (value === null || typeof value !== 'object') {
    return { issue: { serverId: id, field: 'value', message: 'server 配置必须是对象' } }
  }

  const entry = value as Record<string, unknown>
  const command = entry.command

  if (typeof command !== 'string' || command.trim().length === 0) {
    return { issue: { serverId: id, field: 'command', message: '缺少可执行命令' } }
  }

  const args = entry.args ?? []
  if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) {
    return { issue: { serverId: id, field: 'args', message: 'args 必须是字符串数组' } }
  }

  const env: Record<string, string> = {}
  if (entry.env !== undefined) {
    if (entry.env === null || typeof entry.env !== 'object' || Array.isArray(entry.env)) {
      return { issue: { serverId: id, field: 'env', message: 'env 必须是键值对象' } }
    }
    for (const [key, val] of Object.entries(entry.env as Record<string, unknown>)) {
      if (typeof val === 'string') env[key] = val
    }
  }

  const cwd = typeof entry.cwd === 'string' ? entry.cwd : undefined
  const enabled = entry.enabled === false ? false : true

  return {
    server: {
      id: id.trim(),
      command: command.trim(),
      args: args as string[],
      env,
      cwd,
      enabled
    }
  }
}

export interface McpToolRef {
  readonly serverId: string
  readonly name: string
  readonly qualifiedName: string
  readonly description?: string
}

export interface McpToolDecl {
  readonly serverId: string
  readonly name: string
  readonly description?: string
}

export interface MergeResult {
  readonly tools: readonly McpToolRef[]
  /** 同一个 server 里重名的工具，只保留第一个。 */
  readonly collisions: readonly string[]
}

/**
 * 合并多个 server 的工具。
 *
 * 工具名统一成 `server__tool`，避免两个 server 都叫 `search` 时互相覆盖。
 * 名字里的非法字符换成下划线，方便模型调用。
 */
export function mergeTools(
  declarations: readonly (readonly McpToolDecl[])[]
): MergeResult {
  const seen = new Set<string>()
  const tools: McpToolRef[] = []
  const collisions: string[] = []

  for (const list of declarations) {
    for (const decl of list) {
      const qualified = qualifyToolName(decl.serverId, decl.name)
      if (seen.has(qualified)) {
        collisions.push(qualified)
        continue
      }
      seen.add(qualified)
      tools.push({
        serverId: decl.serverId,
        name: decl.name,
        qualifiedName: qualified,
        description: decl.description
      })
    }
  }

  return { tools, collisions }
}

/** `server__tool`，两端都做字符净化。 */
export function qualifyToolName(serverId: string, toolName: string): string {
  const clean = (value: string): string =>
    value
      .trim()
      .replace(/[^A-Za-z0-9_]/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '')

  const server = clean(serverId) || 'server'
  const tool = clean(toolName) || 'tool'
  return `${server}__${tool}`
}

/** 只留下启用的 server。 */
export function enabledServers(servers: readonly McpServerConfig[]): readonly McpServerConfig[] {
  return servers.filter((server) => server.enabled)
}
