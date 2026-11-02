import { describe, expect, it } from 'vitest'
import {
  RockPaperScissors,
  parseRpsChoice,
  rpsOutcome
} from '../rps.js'
import type { RpsChoice } from '../rps.js'

describe('parseRpsChoice', () => {
  it('认得英文三选', () => {
    expect(parseRpsChoice('rock')).toBe('rock')
    expect(parseRpsChoice('paper')).toBe('paper')
    expect(parseRpsChoice('scissors')).toBe('scissors')
  })

  it('认得中文说法', () => {
    expect(parseRpsChoice('石头')).toBe('rock')
    expect(parseRpsChoice('布')).toBe('paper')
    expect(parseRpsChoice('剪刀')).toBe('scissors')
  })

  it('大小写与空白都能容忍', () => {
    expect(parseRpsChoice('  ROCK  ')).toBe('rock')
    expect(parseRpsChoice('\tPaper\n')).toBe('paper')
  })

  it('不认识的说法返回 undefined，不瞎猜', () => {
    expect(parseRpsChoice('我想出石头')).toBeUndefined()
    expect(parseRpsChoice('随便')).toBeUndefined()
    expect(parseRpsChoice('')).toBeUndefined()
  })

  it('宣布游戏名不算出拳', () => {
    expect(parseRpsChoice('剪刀石头布')).toBeUndefined()
  })
})

describe('rpsOutcome', () => {
  const all: readonly RpsChoice[] = ['rock', 'paper', 'scissors']

  it('相同即平局', () => {
    for (const choice of all) {
      expect(rpsOutcome(choice, choice)).toBe('draw')
    }
  })

  it('石头赢剪刀', () => {
    expect(rpsOutcome('rock', 'scissors')).toBe('win')
    expect(rpsOutcome('scissors', 'rock')).toBe('lose')
  })

  it('剪刀赢布', () => {
    expect(rpsOutcome('scissors', 'paper')).toBe('win')
    expect(rpsOutcome('paper', 'scissors')).toBe('lose')
  })

  it('布赢石头', () => {
    expect(rpsOutcome('paper', 'rock')).toBe('win')
    expect(rpsOutcome('rock', 'paper')).toBe('lose')
  })

  it('每组三对胜负关系互补', () => {
    for (const user of all) {
      for (const pet of all) {
        const forward = rpsOutcome(user, pet)
        const backward = rpsOutcome(pet, user)
        if (forward === 'draw') expect(backward).toBe('draw')
        else expect(backward).toBe(forward === 'win' ? 'lose' : 'win')
      }
    }
  })
})

describe('RockPaperScissors', () => {
  it('rng 决定她出什么', () => {
    const zero = new RockPaperScissors({ rng: () => 0 })
    expect(zero.play('rock').pet).toBe('rock')

    const mid = new RockPaperScissors({ rng: () => 0.5 })
    expect(mid.play('rock').pet).toBe('paper')

    const high = new RockPaperScissors({ rng: () => 0.999 })
    expect(high.play('rock').pet).toBe('scissors')
  })

  it('累计战绩正确', () => {
    // 三次 rng 依次给出石头 / 布 / 剪刀
    const values = [0, 0.5, 0.999]
    let index = 0
    const game = new RockPaperScissors({ rng: () => values[index++ % values.length] ?? 0 })

    // 用户全出石头：对石头平、对布输、对剪刀赢
    expect(game.play('rock').outcome).toBe('draw')
    expect(game.play('rock').outcome).toBe('lose')
    expect(game.play('rock').outcome).toBe('win')

    expect(game.stats).toEqual({ rounds: 3, wins: 1, losses: 1, draws: 1 })
  })

  it('reset 清空战绩', () => {
    const game = new RockPaperScissors({ rng: () => 0 })
    game.play('rock')
    game.reset()

    expect(game.stats).toEqual({ rounds: 0, wins: 0, losses: 0, draws: 0 })
  })

  it('rng 越界或非有限值时退回第一项，不产生 undefined', () => {
    for (const bad of [1, -0.1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const game = new RockPaperScissors({ rng: () => bad })
      expect(game.play('scissors').pet).toBe('rock')
    }
  })

  it('每次出拳都会计入局数', () => {
    const game = new RockPaperScissors({ rng: () => 0 })
    game.play('rock')
    game.play('paper')
    expect(game.stats.rounds).toBe(2)
  })

  it('restore 接受自洽的战绩', () => {
    const game = new RockPaperScissors({ rng: () => 0 })
    expect(game.restore({ rounds: 5, wins: 2, losses: 2, draws: 1 })).toBe(true)
    expect(game.stats).toEqual({ rounds: 5, wins: 2, losses: 2, draws: 1 })
  })

  it('restore 拒绝不自洽或非法数据，且不改动现有战绩', () => {
    const game = new RockPaperScissors({ rng: () => 0 })
    game.restore({ rounds: 3, wins: 1, losses: 1, draws: 1 })

    // 和小计对不上
    expect(game.restore({ rounds: 5, wins: 1, losses: 1, draws: 1 })).toBe(false)
    // 负数 / 小数 / 非数字
    expect(game.restore({ rounds: 3, wins: -1, losses: 3, draws: 1 })).toBe(false)
    expect(game.restore({ rounds: 3, wins: 1.5, losses: 0.5, draws: 1 })).toBe(false)
    expect(game.restore({ rounds: 3, wins: 1, losses: 1, draws: 1 })).toBe(true)
    expect(game.restore({ rounds: 3, wins: 1, losses: 1, draws: 1 })).toBe(true)
    expect(game.restore({ rounds: Number.NaN, wins: 0, losses: 0, draws: 0 })).toBe(false)

    expect(game.stats).toEqual({ rounds: 3, wins: 1, losses: 1, draws: 1 })
  })

  it('restore 之后继续出拳会在原战绩上累加', () => {
    const game = new RockPaperScissors({ rng: () => 0 })
    game.restore({ rounds: 4, wins: 1, losses: 2, draws: 1 })
    game.play('rock')

    expect(game.stats).toEqual({ rounds: 5, wins: 1, losses: 2, draws: 2 })
  })
})
