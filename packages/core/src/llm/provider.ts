/**
 * LLM provider 抽象：装配只依赖这一层，真机后端只是最后一块替换件。
 *
 * 超时走真的 AbortController：外层放弃 Promise 时连接仍在，配额会被白占；
 * 这里在超时点 abort，FallbackChain 的 catch 再退预扣令牌。
 */

import type { DailyBudgetGate } from './dailyBudget.js'
import type { LlmAdapter, LlmRawResult } from './fallbackChain.js'

export interface LlmProviderRequest {
  readonly prompt: string
  readonly signal: AbortSignal
}

export interface LlmProviderUsage {
  readonly inputTokens: number
  readonly outputTokens: number
}

export interface LlmProviderResponse {
  readonly text: string
  readonly model: string
  readonly promptVersion: string
  /** usage 是尽力而为：宿主可能一次都不发 usage chunk。 */
  readonly usage?: LlmProviderUsage
}

export interface ILLMProvider {
  readonly id: string
  generate(request: LlmProviderRequest): Promise<LlmProviderResponse>
}

export class LlmTimeoutError extends Error {
  readonly code = 'LLM_TIMEOUT'

  constructor(readonly timeoutMs: number) {
    super(`LLM 请求超时：${timeoutMs}ms`)
    this.name = 'LlmTimeoutError'
  }
}

/** 每日额度耗尽时抛出：调用方不该重试，重试也不会放行。 */
export class LlmBudgetExceededError extends Error {
  readonly code = 'LLM_BUDGET_EXCEEDED'

  constructor(
    readonly used: number,
    readonly limit: number
  ) {
    super(`今日额度已用尽：${used}/${limit}`)
    this.name = 'LlmBudgetExceededError'
  }
}

export interface MockLlmProviderOptions {
  readonly mode?: 'ok' | 'throw' | 'hang'
  readonly text?: string
  readonly model?: string
  readonly promptVersion?: string
  readonly usage?: LlmProviderUsage
}

/** mock 覆盖除真实网络往返外的全部链路；真机替换时不需要改上层。 */
export class MockLlmProvider implements ILLMProvider {
  readonly id = 'mock'
  calls = 0
  aborted = false
  lastSignal: AbortSignal | undefined

  private readonly mode: 'ok' | 'throw' | 'hang'
  private readonly text: string
  private readonly model: string
  private readonly promptVersion: string
  private readonly usage: LlmProviderUsage

  constructor(options: MockLlmProviderOptions = {}) {
    this.mode = options.mode ?? 'ok'
    this.text = options.text ?? 'mock 台词'
    this.model = options.model ?? 'mock-model'
    this.promptVersion = options.promptVersion ?? 'mock-v1'
    this.usage = options.usage ?? { inputTokens: 1, outputTokens: 1 }
  }

  async generate(request: LlmProviderRequest): Promise<LlmProviderResponse> {
    this.calls += 1
    this.lastSignal = request.signal

    if (this.mode === 'throw') {
      throw new Error('mock provider failure')
    }

    if (this.mode === 'hang') {
      return new Promise<never>((_, reject) => {
        const fail = (): void => {
          this.aborted = true
          reject(new Error('mock aborted'))
        }

        if (request.signal.aborted) {
          fail()
          return
        }

        request.signal.addEventListener('abort', fail, { once: true })
      })
    }

    return {
      text: this.text,
      model: this.model,
      promptVersion: this.promptVersion,
      usage: this.usage
    }
  }
}

export interface TimeoutAdapterOptions {
  /**
   * 传入后，每次调用都会过每日额度闸门：
   * 调用前预检、成功后按真实用量结算。不传则完全不参与。
   */
  readonly budget?: DailyBudgetGate
  /** 单次请求的预估 token，用于调用前预检；缺省按 input.text 长度估算。 */
  readonly estimateTokens?: number
}

/** 把 ILLMProvider 包成 FallbackChain 认识的 LlmAdapter，并在超时点真 abort。 */
export function createTimeoutLlmAdapter(
  provider: ILLMProvider,
  timeoutMs: number,
  options: TimeoutAdapterOptions = {}
): LlmAdapter {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`timeoutMs 必须是正数：${timeoutMs}`)
  }

  const budget = options.budget
  const fixedEstimate = options.estimateTokens
  // 没有显式估算值时按输入长度粗估，不能按 0 预检——那等于对未耗尽额度放行。
  const estimateFor = (input: { readonly text: string }): number => {
    if (fixedEstimate !== undefined) return Math.max(0, fixedEstimate)
    return Math.max(1, Math.ceil([...input.text].length / 3))
  }

  return {
    async generate(input): Promise<LlmRawResult> {
      if (budget !== undefined) {
        const verdict = budget.canSpend(estimateFor(input))
        if (!verdict.allowed) {
          throw new LlmBudgetExceededError(verdict.used, verdict.limit)
        }
      }

      const controller = new AbortController()
      let timer: ReturnType<typeof setTimeout> | undefined

      try {
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort()
            reject(new LlmTimeoutError(timeoutMs))
          }, timeoutMs)
        })

        const response = await Promise.race([
          provider.generate({ prompt: input.text, signal: controller.signal }),
          timeout
        ])

        // usage 缺席时标 'unknown'，但预扣不能白退：按输入估算量记账。
        const totalTokens =
          response.usage === undefined
            ? 'unknown'
            : response.usage.inputTokens + response.usage.outputTokens

        if (budget !== undefined) {
          budget.record(typeof totalTokens === 'number' ? totalTokens : estimateFor(input))
        }

        return {
          text: response.text,
          model: response.model,
          promptVersion: response.promptVersion,
          totalTokens
        }
      } finally {
        if (timer !== undefined) clearTimeout(timer)
      }
    }
  }
}
