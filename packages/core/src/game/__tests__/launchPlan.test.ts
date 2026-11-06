import { describe, expect, it } from 'vitest'
import {
  LAUNCH_GRACE_MS,
  decideLaunch,
  gameProcessName,
  type LaunchInput
} from '../launchPlan'

const base: LaunchInput = {
  game: 'genshin',
  mode: 'real',
  launchGame: true
}

describe('decideLaunch', () => {
  it('演练模式不启动游戏，哪怕配置里开了', () => {
    const decision = decideLaunch({ ...base, mode: 'dry' }, () => true)
    expect(decision).toEqual({ action: 'skip', reason: 'dry' })
  })

  it('没有显式允许时不启动', () => {
    const decision = decideLaunch({ ...base, launchGame: false }, () => true)
    expect(decision).toEqual({ action: 'skip', reason: 'disabled' })
  })

  it('显式路径存在就启动它', () => {
    const decision = decideLaunch(
      { ...base, installPath: 'D:\\Genshin Impact Game\\YuanShen.exe' },
      (path) => path === 'D:\\Genshin Impact Game\\YuanShen.exe'
    )
    expect(decision).toEqual({
      action: 'launch',
      exe: 'D:\\Genshin Impact Game\\YuanShen.exe',
      graceMs: LAUNCH_GRACE_MS
    })
  })

  it('显式路径不存在就 blocked，不退回候选路径', () => {
    const decision = decideLaunch(
      { ...base, installPath: 'D:\\nope\\YuanShen.exe' },
      (path) => path !== 'D:\\nope\\YuanShen.exe'
    )
    expect(decision).toEqual({
      action: 'blocked',
      reason: 'missing-install',
      tried: ['D:\\nope\\YuanShen.exe']
    })
  })

  it('没给路径时按候选探测，命中任意一个就启动', () => {
    const hit = 'C:\\Genshin Impact\\YuanShen.exe'
    const decision = decideLaunch(base, (path) => path === hit)
    expect(decision.action).toBe('launch')
    if (decision.action === 'launch') expect(decision.exe).toBe(hit)
  })

  it('候选全都不存在时 blocked，并带回试过的路径', () => {
    const decision = decideLaunch(base, () => false)
    expect(decision.action).toBe('blocked')
    if (decision.action === 'blocked') {
      expect(decision.reason).toBe('missing-install')
      expect(decision.tried.length).toBeGreaterThan(0)
      expect(decision.tried.every((path) => path.endsWith('YuanShen.exe'))).toBe(true)
    }
  })

  it('启动器根目录优先于盘符候选', () => {
    const launcher = 'D:\\miHoYo Launcher\\games\\Genshin Impact Game\\YuanShen.exe'
    const decision = decideLaunch(
      { ...base, candidates: { launcherRoot: 'D:\\miHoYo Launcher' } },
      (path) => path === launcher
    )
    expect(decision.action).toBe('launch')
    if (decision.action === 'launch') expect(decision.exe).toBe(launcher)
  })

  it('进程名取自安装档案', () => {
    expect(gameProcessName('genshin')).toBe('YuanShen.exe')
    expect(gameProcessName('starrail')).toBe('StarRail.exe')
    expect(gameProcessName('hi3')).toBe('BH3.exe')
    expect(gameProcessName('zzz')).toBe('ZenlessZoneZero.exe')
  })
})
