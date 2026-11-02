import { describe, expect, it } from 'vitest'

import {
  GAME_INSTALL_PROFILES,
  candidateExecutables,
  launcherCandidates,
  pickExisting,
  standaloneCandidates
} from '../installPaths'
import { GAME_IDS, type GameId } from '../dailySchedule'

describe('游戏安装位置推导', () => {
  it('每个游戏都有可执行文件名和启动器目录名', () => {
    for (const game of GAME_IDS) {
      const profile = GAME_INSTALL_PROFILES[game]
      expect(profile.exe).toMatch(/\.exe$/)
      expect(profile.launcherDir.length).toBeGreaterThan(0)
      expect(profile.standaloneDirs.length).toBeGreaterThan(0)
    }
  })

  it('国服文件名按实测填：原神是 YuanShen.exe，星铁是 StarRail.exe', () => {
    expect(GAME_INSTALL_PROFILES.genshin.exe).toBe('YuanShen.exe')
    expect(GAME_INSTALL_PROFILES.starrail.exe).toBe('StarRail.exe')
  })

  it('启动器路径按 games/<目录>/<exe> 拼出来', () => {
    const result = launcherCandidates('genshin', 'D:\\绝区零\\miHoYo Launcher')
    expect(result).toEqual([
      'D:\\绝区零\\miHoYo Launcher\\games\\Genshin Impact Game\\YuanShen.exe'
    ])
  })

  it('根目录末尾带反斜杠也能拼对，不会出现双斜杠', () => {
    const result = launcherCandidates('starrail', 'D:\\绝区零\\miHoYo Launcher\\')
    expect(result).toEqual([
      'D:\\绝区零\\miHoYo Launcher\\games\\Star Rail Game\\StarRail.exe'
    ])
  })

  it('没给启动器根目录时返回空数组，不猜路径', () => {
    expect(launcherCandidates('zzz')).toEqual([])
    expect(launcherCandidates('zzz', '   ')).toEqual([])
  })

  it('独立安装按盘符展开，覆盖 Program Files 两个变体', () => {
    const result = standaloneCandidates('starrail', ['D:'])
    expect(result).toContain('D:\\Star Rail\\StarRail.exe')
    expect(result).toContain('D:\\Program Files\\Star Rail\\StarRail.exe')
    expect(result).toContain('D:\\Program Files (x86)\\Star Rail\\StarRail.exe')
  })

  it('盘符数量决定候选数量，不重复', () => {
    const one = standaloneCandidates('genshin', ['C:'])
    const two = standaloneCandidates('genshin', ['C:', 'D:'])
    expect(two.length).toBe(one.length * 2)
    expect(new Set(two).size).toBe(two.length)
  })

  it('候选顺序：启动器在前，独立安装在后', () => {
    const result = candidateExecutables('genshin', {
      launcherRoot: 'D:\\绝区零\\miHoYo Launcher',
      drives: ['D:']
    })
    expect(result[0]).toBe(
      'D:\\绝区零\\miHoYo Launcher\\games\\Genshin Impact Game\\YuanShen.exe'
    )
    expect(result.length).toBeGreaterThan(1)
  })

  it('没给启动器根目录时只剩独立安装候选', () => {
    const result = candidateExecutables('hi3', { drives: ['D:'] })
    expect(result.every((path) => path.endsWith('BH3.exe'))).toBe(true)
    expect(result.some((path) => path.includes('miHoYo Launcher'))).toBe(false)
  })

  it('pickExisting 返回第一个存在的路径', () => {
    const existing = 'D:\\b\\StarRail.exe'
    const result = pickExisting(['D:\\a\\StarRail.exe', existing, 'D:\\c\\StarRail.exe'], (path) => {
      return path === existing
    })
    expect(result).toBe(existing)
  })

  it('pickExisting 一个都不存在时返回 null，不退化成第一个候选', () => {
    expect(pickExisting(['D:\\a.exe', 'D:\\b.exe'], () => false)).toBeNull()
  })

  it('pickExisting 空数组返回 null', () => {
    expect(pickExisting([], () => true)).toBeNull()
  })

  it('四个游戏 id 都能独立推导，互不串味', () => {
    const seen = new Set<string>()
    for (const game of GAME_IDS as readonly GameId[]) {
      const [path] = launcherCandidates(game, 'D:\\L')
      seen.add(GAME_INSTALL_PROFILES[game].exe)
      expect(path).toContain(GAME_INSTALL_PROFILES[game].launcherDir)
    }
    expect(seen.size).toBe(GAME_IDS.length)
  })
})
