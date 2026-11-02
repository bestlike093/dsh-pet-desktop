type AnyRecord = Record<string, any>

/**
 * Live2D 模型库：导入、切换、打开目录。
 *
 * 模型文件不随包分发，全部由使用者自己从作者处下载后导入，放在 userData/models。
 * 渲染侧只拿 pet-media:// 相对地址，拿不到真实路径。
 */
export interface ModelChannelDeps {
  registerChannel: (channel: string, listener: (...args: any[]) => unknown) => void
  dialog: {
    showOpenDialog: (
      parent: unknown,
      options: AnyRecord
    ) => Promise<{ canceled: boolean; filePaths: string[] }>
  }
  getDialogParent: () => unknown
  modelStore: {
    importFromZip: (source: string) => Promise<AnyRecord>
    importFromDirectory: (source: string) => Promise<AnyRecord>
    list: () => Promise<AnyRecord[]>
    toMediaUrl: (model: AnyRecord) => string
    ensureRoot: () => Promise<void>
  }
  mediaRoot: string
  openPath: (target: string) => Promise<string>
  getSettings: () => AnyRecord
  setSettings: (next: AnyRecord) => void
  settingsPath: string
  writeJson: (file: string, value: unknown) => Promise<void>
  broadcastSettings: (next: AnyRecord) => void
  log: (...args: any[]) => void
}

export function registerModelChannels(deps: ModelChannelDeps): void {
  const register = deps.registerChannel

  /**
   * 导入模型。payload.kind 决定弹哪种选择框：
   * - zip：选一个压缩包，由主进程解压
   * - folder：选一个已经解压好的文件夹
   * 导入成功后直接切换过去，省掉「导入完还要再点一次」。
   */
  register('pet:models:import', async (_event, payload) => {
    const kind = payload?.kind === 'folder' ? 'folder' : 'zip'

    const picked = await deps.dialog.showOpenDialog(deps.getDialogParent(), {
      title: kind === 'zip' ? '选择模型压缩包（.zip）' : '选择模型文件夹',
      properties: kind === 'zip' ? ['openFile'] : ['openDirectory'],
      ...(kind === 'zip' ? { filters: [{ name: '压缩包', extensions: ['zip'] }] } : {})
    })
    if (picked.canceled || picked.filePaths.length === 0) {
      return { ok: false, canceled: true }
    }

    const source = picked.filePaths[0]
    const startedAt = Date.now()
    try {
      const imported =
        kind === 'zip'
          ? await deps.modelStore.importFromZip(source as string)
          : await deps.modelStore.importFromDirectory(source as string)

      deps.log('[models] 导入完成：', imported.id, `${Date.now() - startedAt}ms`)
      const next = { ...deps.getSettings(), live2dModelId: imported.id }
      deps.setSettings(next)
      await deps.writeJson(deps.settingsPath, next)
      deps.broadcastSettings(next)

      return {
        ok: true,
        model: { ...imported, url: deps.modelStore.toMediaUrl(imported) },
        models: await deps.modelStore.list()
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      deps.log('[models] 导入失败：', message)
      return { ok: false, message }
    }
  })

  /** 切换当前模型；空串表示「不使用模型」，桌宠回到空态引导。 */
  register('pet:models:setActive', async (_event, modelId) => {
    const id = typeof modelId === 'string' ? modelId.trim() : ''
    if (id !== '') {
      const models = await deps.modelStore.list()
      const hit = models.find((item) => item.id === id)
      if (hit === undefined) return { ok: false, message: '找不到这个模型' }
      if (!hit.valid) return { ok: false, message: hit.reason ?? '模型文件不完整' }
    }

    const next = { ...deps.getSettings(), live2dModelId: id }
    deps.setSettings(next)
    await deps.writeJson(deps.settingsPath, next)
    deps.broadcastSettings(next)
    return { ok: true, live2dModelId: id }
  })

  /** 在资源管理器里打开模型目录，方便使用者自己看/清。 */
  register('pet:models:openFolder', async () => {
    await deps.modelStore.ensureRoot()
    const error = await deps.openPath(deps.mediaRoot)
    return error === '' ? { ok: true } : { ok: false, message: error }
  })
}
