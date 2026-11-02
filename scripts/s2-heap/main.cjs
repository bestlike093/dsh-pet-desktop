// S2 堆快照探针：Electron 主进程。
// 用法：
//   electron --no-sandbox scripts/s2-heap/main.cjs               # 正式复测
//   electron --no-sandbox scripts/s2-heap/main.cjs --self-test   # 判据自检 + 新旧行为对照
//   electron --no-sandbox scripts/s2-heap/main.cjs --legacy      # 旧度量源对照
//
// 采样：HeapProfiler.collectGarbage + Runtime.getHeapUsage。
// 判据只有一条：GC 之后，堆是否仍随切换次数上升。与幅度无关，没有噪声下限。
const { app, BrowserWindow } = require('electron')
const path = require('node:path')

// 只给 --legacy 对照用。正式采样不依赖 global.gc：
// typeof gc === 'function' 只能证明符号存在，证明不了它回收了东西。
app.commandLine.appendSwitch('js-flags', '--expose-gc')
app.disableHardwareAcceleration()

const ROUNDS = 40
const WARMUP = 5
// 只比较末段：前段可能有一次性的冷启动分配，末段还在涨才说明对象持续被持有。
const TAIL_FRACTION = 1 / 3

function round2(value) {
  return Math.round(value * 100) / 100
}

function slope(values) {
  const n = values.length
  if (n <= 1) return 0
  const meanX = (n - 1) / 2
  let meanY = 0
  for (let i = 0; i < n; i += 1) meanY += values[i]
  meanY /= n

  let num = 0
  let den = 0
  for (let i = 0; i < n; i += 1) {
    const dx = i - meanX
    num += dx * (values[i] - meanY)
    den += dx * dx
  }
  return den === 0 ? 0 : num / den
}

/**
 * 判据：GC 后堆是否仍在上升。
 *
 * 每个采样点前都执行了 collectGarbage，读到的已经是「GC 后仍被持有」的部分，
 * 一次性垃圾在下一次采样前就没了。所以幅度不参与判断，没有噪声下限：
 * 末段涨 1 字节也是泄漏，涨 1MB 也是泄漏。
 */
function judge(kind, samples) {
  const tailStart = Math.floor(samples.length * (1 - TAIL_FRACTION))
  const tail = samples.slice(tailStart)
  return {
    kind,
    samples,
    tailStart,
    tailRise: samples[samples.length - 1] - samples[tailStart],
    tailSlope: round2(slope(tail)),
    overallRise: samples[samples.length - 1] - samples[0],
    overallSlope: round2(slope(samples)),
    pass: samples[samples.length - 1] - samples[tailStart] <= 0
  }
}

/**
 * 17.2.46 的旧判据，只用于新旧行为对照，已废弃。
 * 漏洞：前半段有一次大分配时，后半段哪怕一直在涨，也会被「不高于前段 50%」放过。
 */
function legacyJudge(kind, samples) {
  const half = Math.floor(samples.length / 2)
  const first = slope(samples.slice(0, half))
  const second = slope(samples.slice(half))
  const SLOPE_TOLERANCE = 2
  return {
    kind,
    firstHalfSlope: round2(first),
    secondHalfSlope: round2(second),
    pass: second <= Math.max(SLOPE_TOLERANCE, first * 0.5)
  }
}

function createWindow() {
  return new BrowserWindow({
    show: false,
    width: 320,
    height: 320,
    webPreferences: {
      offscreen: true,
      backgroundThrottling: false
    }
  })
}

async function run() {
  const win = createWindow()
  await win.loadFile(path.join(__dirname, 'page.html'))

  const stateBefore = await win.webContents.executeJavaScript('window.getProbeState()')

  // 旧路径对照：确认 --expose-gc 与 performance.memory 在当前 Electron 里的实际行为。
  if (process.argv.includes('--legacy')) {
    const legacy = await win.webContents.executeJavaScript('window.legacyProbe()')
    const legacyResult = {
      mode: 'legacy',
      hasGc: legacy.hasGc,
      gcError: legacy.gcError,
      memoryValues: legacy.memoryValues,
      memoryDistinct: new Set(legacy.memoryValues.filter((value) => value !== null)).size
    }
    console.log(JSON.stringify(legacyResult, null, 2))
    win.destroy()
    app.exit(0)
    return
  }

  win.webContents.debugger.attach('1.3')
  const dbg = win.webContents.debugger
  await dbg.sendCommand('Runtime.enable')
  await dbg.sendCommand('HeapProfiler.enable')

  async function heapUsed() {
    await dbg.sendCommand('HeapProfiler.collectGarbage')
    const usage = await dbg.sendCommand('Runtime.getHeapUsage')
    return usage.usedSize
  }

  // GC 有效性验证：符号存在不算数，调用后堆必须真的下降。
  // 不验这一步，后面所有「GC 后仍存活」的读数都可能是假的。
  const gcAudit = await (async () => {
    const before = (await dbg.sendCommand('Runtime.getHeapUsage')).usedSize
    await win.webContents.executeJavaScript('window.allocateGarbage(4 * 1024 * 1024)')
    const afterAlloc = (await dbg.sendCommand('Runtime.getHeapUsage')).usedSize
    await dbg.sendCommand('HeapProfiler.collectGarbage')
    const afterGc = (await dbg.sendCommand('Runtime.getHeapUsage')).usedSize
    return {
      before,
      afterAlloc,
      afterGc,
      dropped: afterAlloc - afterGc,
      effective: afterGc < afterAlloc
    }
  })()

  if (!gcAudit.effective) {
    console.log(JSON.stringify({ gcAudit }, null, 2))
    console.log('GC_NOT_EFFECTIVE')
    win.destroy()
    app.exit(4)
    return
  }

  const kinds = ['image', 'gif', 'video', 'live2d']
  const results = []

  for (const kind of kinds) {
    for (let i = 0; i < WARMUP; i += 1) {
      await win.webContents.executeJavaScript(`window.runOneRound(${JSON.stringify(kind)}, -${i + 1})`)
    }

    const samples = []
    for (let i = 0; i < ROUNDS; i += 1) {
      await win.webContents.executeJavaScript(`window.runOneRound(${JSON.stringify(kind)}, ${i})`)
      samples.push(await heapUsed())
    }
    results.push(judge(kind, samples))
  }

  const stateAfter = await win.webContents.executeJavaScript('window.getProbeState()')

  // 活性检查：渲染侧必须真的在跑，否则「无增长」毫无意义。
  const stageOk = stateAfter.stage.width !== 300 || stateAfter.stage.height !== 150
  const statusOk = stateAfter.statusUpdates >= ROUNDS * kinds.length
  const allSamples = results.flatMap((item) => item.samples)
  const heapVaried = new Set(allSamples).size > 1
  const active = stageOk && statusOk && heapVaried

  const report = {
    judgedBy: 'gc-survivor',
    rounds: ROUNDS,
    warmup: WARMUP,
    gcAudit,
    activity: {
      before: stateBefore,
      after: stateAfter,
      stageOk,
      statusOk,
      heapVaried,
      active
    },
    results
  }
  console.log(JSON.stringify(report, null, 2))

  if (!active) {
    console.log('PROBE_INACTIVE')
    win.destroy()
    app.exit(3)
    return
  }

  const failed = results.filter((item) => !item.pass)

  // 自检：判据要能区分两种形态，且新旧行为可对照。
  let selfTestOk = true
  if (process.argv.includes('--self-test')) {
    async function sampleRounds(jsCall) {
      const samples = []
      for (let i = 0; i < ROUNDS; i += 1) {
        await win.webContents.executeJavaScript(jsCall)
        samples.push(await heapUsed())
      }
      return samples
    }

    // A. 大幅线性泄漏：新判据、旧判据都该判红。
    const leakySamples = await sampleRounds('window.runLeakyRound()')
    const leakyNew = judge('leaky-64k', leakySamples)
    const leakyLegacy = legacyJudge('leaky-64k', leakySamples)
    const leakyOk = !leakyNew.pass

    // B. 缓慢泄漏：前 10 轮一次大分配，之后每轮只漏一点。
    //    旧判据会因「后段不高于前段 50%」放过，新判据必须抓住。
    const tailSamples = await sampleRounds('window.runUnrevokedRound()')
    const tailNew = judge('unrevoked', tailSamples)
    const tailLegacy = legacyJudge('unrevoked', tailSamples)
    const tailOk = !tailNew.pass

    selfTestOk = leakyOk && tailOk
    console.log('SELFTEST ' + (selfTestOk ? 'EXPECTED_FAIL' : 'UNEXPECTED_PASS'))
    console.log(
      JSON.stringify(
        {
          leaky: {
            newVerdict: leakyNew.pass ? 'PASS (wrong)' : 'FAIL (expected)',
            legacyVerdict: leakyLegacy.pass ? 'PASS' : 'FAIL',
            tailRise: leakyNew.tailRise,
            overallSlope: leakyNew.overallSlope
          },
          unrevoked: {
            newVerdict: tailNew.pass ? 'PASS (wrong)' : 'FAIL (expected)',
            legacyVerdict: tailLegacy.pass ? 'PASS (blind spot)' : 'FAIL',
            tailRise: tailNew.tailRise,
            overallSlope: tailNew.overallSlope,
            legacyFirstHalfSlope: tailLegacy.firstHalfSlope,
            legacySecondHalfSlope: tailLegacy.secondHalfSlope,
            samples: tailSamples
          }
        },
        null,
        2
      )
    )
  }

  if (failed.length === 0 && selfTestOk) {
    console.log('S2_HEAP_OK')
  } else {
    const names = failed.map((item) => item.kind)
    if (!selfTestOk) names.push('selftest')
    console.log('S2_HEAP_FAIL ' + names.join(','))
  }

  win.destroy()
  app.exit(failed.length === 0 && selfTestOk ? 0 : 1)
}

app.whenReady().then(run).catch((error) => {
  console.error('S2_HEAP_ERROR', error)
  app.exit(2)
})
