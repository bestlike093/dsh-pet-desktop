import { describe, expect, it } from 'vitest'
import {
  buildQueryScript,
  buildRegisterScript,
  buildRunnerArguments,
  buildUnregisterScript,
  quotePowerShell,
  weekdayNames
} from '../taskRegistration.js'

const SPEC = {
  name: 'Cyrene-game-daily-genshin',
  time: '04:00',
  days: [] as readonly number[],
  executionLimitMinutes: 160,
  mode: 'dry' as const
}

const ACTION = {
  program: 'C:\\Program Files\\nodejs\\node.exe',
  arguments: '--game "genshin"',
  workingDirectory: 'D:\\Cyrene\\game-daily'
}

describe('quotePowerShell', () => {
  it('单引号写两遍', () => {
    expect(quotePowerShell("C:\\O'Brien")).toBe("'C:\\O''Brien'")
  })

  it('普通路径原样包住', () => {
    expect(quotePowerShell('D:\\a b\\c')).toBe("'D:\\a b\\c'")
  })
})

describe('weekdayNames', () => {
  it('0 是周日', () => {
    expect(weekdayNames([0])).toEqual(['Sunday'])
  })

  it('按顺序映射并丢掉非法值', () => {
    expect(weekdayNames([1, 5, 9, -1])).toEqual(['Monday', 'Friday'])
  })
})

describe('buildRunnerArguments', () => {
  it('路径带空格时仍然被双引号包住', () => {
    expect(buildRunnerArguments('genshin', { stateDir: 'C:\\Users\\someone\\a b' })).toBe(
      '--game "genshin" --state-dir "C:\\Users\\someone\\a b"'
    )
  })

  it('可选 runId 放在最后', () => {
    expect(buildRunnerArguments('hi3', { stateDir: 'D:\\s', runId: 'r-1' })).toContain('--run-id "r-1"')
  })
})

describe('buildRegisterScript', () => {
  it('每天触发用 -Daily', () => {
    const script = buildRegisterScript({ spec: SPEC, action: ACTION })
    expect(script).toContain('New-ScheduledTaskTrigger -Daily -At \'04:00\'')
    expect(script).toContain('Register-ScheduledTask')
    expect(script).toContain('\\Cyrene\\')
  })

  it('执行时限是超时加余量', () => {
    const script = buildRegisterScript({ spec: SPEC, action: ACTION })
    expect(script).toContain('New-TimeSpan -Minutes 160')
  })

  it('指定执行日时用 -Weekly', () => {
    const script = buildRegisterScript({
      spec: { ...SPEC, days: [1, 3] },
      action: ACTION
    })
    expect(script).toContain('-Weekly -DaysOfWeek \'Monday\',\'Wednesday\'')
  })

  it('默认以最高权限注册，且只在登录会话里跑', () => {
    const script = buildRegisterScript({ spec: SPEC, action: ACTION })
    expect(script).toContain('-RunLevel Highest')
    expect(script).toContain('-LogonType Interactive')
  })

  it('同一任务不会并跑', () => {
    const script = buildRegisterScript({ spec: SPEC, action: ACTION })
    expect(script).toContain('-MultipleInstances IgnoreNew')
  })

  it('路径里的单引号被转义，不会截断脚本', () => {
    const script = buildRegisterScript({
      spec: { ...SPEC, name: "Cyrene's task" },
      action: { ...ACTION, workingDirectory: "D:\\O'Brien" }
    })
    expect(script).toContain("'Cyrene''s task'")
    expect(script).toContain("'D:\\O''Brien'")
  })
})

describe('buildUnregisterScript', () => {
  it('一次删多个任务，且不存在时不报错', () => {
    const script = buildUnregisterScript(['a', 'b'])
    expect(script).toContain("$ErrorActionPreference = 'SilentlyContinue'")
    expect(script).toContain("'a','b'")
    expect(script).toContain('Unregister-ScheduledTask')
  })
})

describe('buildQueryScript', () => {
  it('输出 JSON，便于宿主直接解析', () => {
    const script = buildQueryScript(['a'])
    expect(script).toContain('Get-ScheduledTask')
    expect(script).toContain('ConvertTo-Json')
  })
})
