/**
 * 降级链：LLM → 本地规则 → 预置池。
 *
 * source 一律取自实际走过的路径，不读配置：配了 key 但请求失败，
 * 标记的仍是真正产出这条台词的那一级。
 *
 * 本地两级降级都是同步计算，catch 之后不再嵌 await。
 */

import { ErrorCode, PetError } from '@pet/shared'
import type { EmotionTag } from '@pet/shared'
import type { DialogueQueue } from '../dialogue/dialogueQueue.js'
import type { LocalEmotionEngine } from '../emotion/localEmotion.js'
import type { ConsumeResult, TokenBucket } from './tokenBucket.js'

export type GenerationSource = 'llm' | 'local-rule' | 'preset-pool'

export interface GenerationInput {
  readonly text: string
  readonly emotion?: EmotionTag
}

export interface LlmRawResult {
  readonly text: string
  readonly model: string
  readonly promptVersion: string
  /**
   * 事后结算用。拿不到用量时必须写 'unknown'：
   * 用 0 或直接省略字段，等于把「未知」伪装成「已知」，配额会被静默绕过。
   */
  readonly totalTokens: number | 'unknown'
}

export interface LlmAdapter {
  generate(input: GenerationInput): Promise<LlmRawResult>
}

export interface PresetPick {
  readonly text: string
  readonly poolId: string
  readonly index: number
}

export interface PresetPoolLike {
  pick(emotion: EmotionTag): PresetPick | undefined
}

/** 三级来源各自的溯源信息，source 与 kind 必须一致。 */
export type Provenance =
  | { readonly kind: 'llm'; readonly model: string; readonly promptVersion: string }
  /** matchedRule 为 null：规则命中但台词表没有对应条目，产出的是通用回落句。 */
  | { readonly kind: 'local-rule'; readonly matchedRule: string | null }
  | { readonly kind: 'preset-pool'; readonly poolId: string; readonly pickedIndex: number }

export interface GenerationOutput {
  readonly text: string
  readonly source: GenerationSource
  readonly provenance: Provenance
}

export type DiagnosticLevel = 'info' | 'warn' | 'error'

export interface FallbackDiagnostic {
  readonly level: DiagnosticLevel
  readonly source: GenerationSource | null
  readonly message: string
}

export interface GenerationReport {
  readonly output: GenerationOutput
  readonly diagnostics: readonly FallbackDiagnostic[]
}

export interface FallbackChainOptions {
  readonly llm?: LlmAdapter
  readonly localRules?: LocalEmotionEngine
  readonly presetPool?: PresetPoolLike
  readonly bucket?: TokenBucket
  readonly queue?: DialogueQueue
  /** 调用前预扣多少 token，默认 1。 */
  readonly estimateTokens?: (input: GenerationInput) => number
}

const LOCAL_RULE_LINES: Readonly<Record<string, string>> = {
  gratitude: '被这样感谢，人家有点不好意思呢♪',
  greeting: '嗨♪今天想怎么度过？',
  praise: '诶嘿，被夸了呢♪',
  anger: '先别生气嘛，慢慢说给我听。',
  sadness: '难过的时候，人家陪你待一会儿。',
  fatigue: '累了就歇一歇吧，我在这儿。',
  surprise: '真的吗？快说给我听♪',
  question: '让我想想……你更在意哪一部分？',
  excitement: '看你这么开心，我也跟着高兴起来啦♪'
}

const DEFAULT_LOCAL_LINE = '嗯，我在听呢♪'

/** 未注入估算器时按输入长度粗估：中文按 3 字符 ≈ 1 token，至少 1。 */
function defaultEstimateTokens(input: GenerationInput): number {
  return Math.max(1, Math.ceil([...input.text].length / 3))
}

/**
 * 缺报判定。编译期已知只有 number | 'unknown'，运行时仍兜 undefined——
 * 不走编译的旧调用方会直接省略该字段。两层都要，删任一层就是 E-7 复发通道。
 */
function isUnknownTotalTokens(
  value: LlmRawResult['totalTokens'] | undefined
): value is 'unknown' | undefined {
  return value === 'unknown' || value === undefined
}

/** 最小预置池：按轮转取，便于测试复现。 */
export class PresetPool implements PresetPoolLike {
  private cursor = 0

  constructor(
    private readonly lines: readonly string[],
    readonly poolId = 'default'
  ) {}

  pick(_emotion: EmotionTag): PresetPick | undefined {
    if (this.lines.length === 0) return undefined

    const index = this.cursor % this.lines.length
    this.cursor += 1

    return { text: this.lines[index]!, poolId: this.poolId, index }
  }
}

export class FallbackChain {
  private readonly llm: LlmAdapter | undefined
  private readonly localRules: LocalEmotionEngine | undefined
  private readonly presetPool: PresetPoolLike | undefined
  private readonly bucket: TokenBucket | undefined
  private readonly queue: DialogueQueue | undefined
  private readonly estimateTokens: (input: GenerationInput) => number

  constructor(options: FallbackChainOptions = {}) {
    this.llm = options.llm
    this.localRules = options.localRules
    this.presetPool = options.presetPool
    this.bucket = options.bucket
    this.queue = options.queue
    this.estimateTokens = options.estimateTokens ?? defaultEstimateTokens
  }

  /**
   * 生成一条台词。LLM 成功才标 llm；桶空或请求失败都走同步降级。
   */
  async generate(input: GenerationInput): Promise<GenerationReport> {
    const diagnostics: FallbackDiagnostic[] = []

    let consumed: ConsumeResult | undefined
    let reserved = 0

    if (this.bucket !== undefined) {
      reserved = this.estimateTokens(input)
      consumed = this.bucket.tryConsume(reserved)

      if (!consumed.ok) {
        diagnostics.push({
          level: 'info',
          source: null,
          message: consumed.reason === 'exceeds-capacity' ? 'request exceeds bucket capacity' : 'quota exhausted'
        })
      }
    }

    if (this.llm !== undefined && (consumed === undefined || consumed.ok)) {
      try {
        const raw = await this.llm.generate(input)

        if (consumed?.ok) {
          if (isUnknownTotalTokens(raw.totalTokens)) {
            // 无法结算时保留全额预扣：宁可多扣，也不能让不报用量的 adapter 绕过桶。
            diagnostics.push({
              level: 'warn',
              source: 'llm',
              message: 'totalTokens missing: reserved tokens kept, no refund'
            })
          } else {
            const actual = Math.max(0, raw.totalTokens)
            this.bucket?.refund(reserved - actual)
          }
        }

        return {
          output: {
            text: raw.text,
            source: 'llm',
            provenance: { kind: 'llm', model: raw.model, promptVersion: raw.promptVersion }
          },
          diagnostics
        }
      } catch {
        if (consumed?.ok) this.bucket?.refund(reserved)
        diagnostics.push({ level: 'warn', source: null, message: 'llm failed, falling back' })
      }
    }

    return this.fallback(input, diagnostics)
  }

  /** 降级产出与普通台词走同一条入队路径，一律 normal。 */
  enqueue(output: GenerationOutput): void {
    this.queue?.enqueue({ text: output.text, priority: 'normal' })
  }

  async generateAndEnqueue(input: GenerationInput): Promise<GenerationReport> {
    const report = await this.generate(input)
    this.enqueue(report.output)
    return report
  }

  /** 同步完成，不引入新的 await 点。 */
  private fallback(input: GenerationInput, diagnostics: FallbackDiagnostic[]): GenerationReport {
    const snapshot = this.localRules?.analyze(input.text)

    if (snapshot !== undefined && snapshot.matchedRule !== null) {
      const line = LOCAL_RULE_LINES[snapshot.matchedRule]

      if (line !== undefined) {
        return {
          output: {
            text: line,
            source: 'local-rule',
            provenance: { kind: 'local-rule', matchedRule: snapshot.matchedRule }
          },
          diagnostics
        }
      }

      // 规则命中但台词表没有这一条：如实标未命中，不冒充 matchedRule。
      diagnostics.push({
        level: 'warn',
        source: 'local-rule',
        message: `rule matched without line: ${snapshot.matchedRule}`
      })

      return {
        output: {
          text: DEFAULT_LOCAL_LINE,
          source: 'local-rule',
          provenance: { kind: 'local-rule', matchedRule: null }
        },
        diagnostics
      }
    }

    const emotion = input.emotion ?? snapshot?.emotion ?? 'neutral'
    const picked = this.presetPool?.pick(emotion)

    if (picked !== undefined) {
      return {
        output: {
          text: picked.text,
          source: 'preset-pool',
          provenance: { kind: 'preset-pool', poolId: picked.poolId, pickedIndex: picked.index }
        },
        diagnostics
      }
    }

    diagnostics.push({ level: 'error', source: null, message: 'no fallback output available' })
    // 诊断随异常载荷走，不再随裸 Error 的栈一起丢掉。
    throw new PetError(ErrorCode.FALLBACK_EXHAUSTED, 'FALLBACK_EXHAUSTED: 降级链耗尽，无可用输出', {
      details: { diagnostics }
    })
  }
}
