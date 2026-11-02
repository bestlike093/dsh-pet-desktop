/**
 * 契约声明提取器。
 *
 * 独立成模块，是为了能被自测脚本直接 import —— 守卫本身也要被验证覆盖。
 *
 * 历史盲区（都必须有 fixture 守住）：
 * 1. `interface Port<T extends { id: string }> { ... }` —— 声明头里的对象字面量
 *    会与泛型尖括号在同一声明行配对，旧的「总深度归零」判定会误以为接口结束，
 *    结果只记下声明头、成员全部丢失；
 * 2. union 中间夹注释 —— 注释被抹成空白行后，旧的续写判断会在这里断开，
 *    后半段成员从此不进快照。
 *
 * 两种都表现为「静默少记」，不是报错。
 */

/** 把块注释和行注释替换成等长空白，保留换行，避免注释里的花括号干扰深度计数。 */
export function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (line) => ' '.repeat(line.length))
}

export const normalize = (text) => text.replace(/\s+/g, ' ').trim()

/**
 * 逐个提取顶层 export 类型声明。
 *
 * - interface：先跳过泛型参数（只跟踪 `<>`），深度归零后的第一个 `{` 才是主体；
 *   主体内只按 `{}` 配平。
 * - type 别名：跟踪全部括号，靠「本行是否续写」判断是否结束；续写判断会跳过
 *   被注释抹出的空行，看向下一个有效行。
 */
export function extractDeclarations(source) {
  const lines = stripComments(source).split(/\r?\n/)
  const found = new Map()
  let i = 0

  while (i < lines.length) {
    const head = /^export (interface|type) ([A-Za-z0-9_]+)/.exec(lines[i])
    if (!head) {
      i += 1
      continue
    }

    const [, kind, name] = head
    const start = i
    let depth = 0
    let bodyStarted = false
    let done = false

    while (i < lines.length && !done) {
      const line = lines[i]
      for (const ch of line) {
        if (kind === 'interface') {
          if (!bodyStarted) {
            if (ch === '<') depth += 1
            else if (ch === '>') depth = Math.max(0, depth - 1)
            else if (ch === '{' && depth === 0) {
              bodyStarted = true
              depth = 1
            }
            continue
          }
          if (ch === '{') depth += 1
          else if (ch === '}') depth -= 1
        } else if (ch === '{' || ch === '(' || ch === '[' || ch === '<') {
          depth += 1
        } else if (ch === '}' || ch === ')' || ch === ']' || ch === '>') {
          depth = Math.max(0, depth - 1)
        }
      }
      i += 1

      if (kind === 'interface') {
        if (bodyStarted && depth <= 0) done = true
      } else if (depth <= 0) {
        const trimmed = line.trimEnd()
        let next = ''
        for (let j = i; j < lines.length; j += 1) {
          const candidate = lines[j].trim()
          if (candidate) {
            next = candidate
            break
          }
        }
        const continues = /[=|,&]$/.test(trimmed) || /^[|&,]/.test(next)
        if (!continues) done = true
      }
    }

    found.set(name, normalize(lines.slice(start, i).join('\n')))
  }

  return found
}
