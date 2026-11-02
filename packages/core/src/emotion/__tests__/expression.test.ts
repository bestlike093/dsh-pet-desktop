import { describe, expect, it } from 'vitest'
import { ExpressionExperiment } from '../expression.js'

describe('表情表达实验：三组对照与计数（E2）', () => {
  it('off：始终用默认表情，且不计入实验数据', () => {
    const experiment = new ExpressionExperiment({ group: 'off', defaultEmotion: 'neutral', now: () => 1 })
    const decision = experiment.decide('happy')

    expect(decision.tag).toBe('neutral')
    expect(decision.changed).toBe(false)
    expect(experiment.stats().total).toBe(0)
  })

  it('experiment：按情绪切换表情并累计命中', () => {
    const experiment = new ExpressionExperiment({ group: 'experiment', defaultEmotion: 'neutral', now: () => 1 })

    expect(experiment.decide('happy').tag).toBe('happy')
    expect(experiment.decide('sad').tag).toBe('sad')
    expect(experiment.decide('happy').tag).toBe('happy')

    const stats = experiment.stats()
    expect(stats.total).toBe(3)
    expect(stats.changed).toBe(3)
    expect(stats.byTag).toEqual({ happy: 2, sad: 1 })
  })

  it('experiment：neutral 用默认表情，不算切换', () => {
    const experiment = new ExpressionExperiment({ group: 'experiment', defaultEmotion: 'gentle', now: () => 1 })
    const decision = experiment.decide('neutral')

    expect(decision.tag).toBe('gentle')
    expect(decision.changed).toBe(false)
    expect(experiment.stats().changed).toBe(0)
  })

  it('control：保持默认表情，只记录计数', () => {
    const experiment = new ExpressionExperiment({ group: 'control', defaultEmotion: 'neutral', now: () => 1 })
    const decision = experiment.decide('angry')

    expect(decision.tag).toBe('neutral')
    expect(decision.changed).toBe(false)
    expect(experiment.stats().total).toBe(1)
    expect(experiment.stats().byTag).toEqual({ neutral: 1 })
  })

  it('切换分组后计数保留，resetStats 可清零', () => {
    const experiment = new ExpressionExperiment({ group: 'experiment', defaultEmotion: 'neutral', now: () => 1 })

    experiment.decide('happy')
    experiment.setGroup('control')
    experiment.decide('happy')

    expect(experiment.stats().total).toBe(2)
    experiment.resetStats()
    expect(experiment.stats()).toEqual({ total: 0, changed: 0, byTag: {} })
  })
})
