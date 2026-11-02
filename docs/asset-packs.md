# 素材包（Asset Packs）

一个 zip 就能同时换掉托盘图标、任务栏图标、气泡底图、气泡字体和气泡旁贴纸。
设置入口：**设置 → 通用 → 素材包 → 选择 zip**。

## 目录结构

压缩包根目录按类型分目录即可，不需要写配置：

```
my-pack/
  icons/
    tray.ico
    app.png
  fonts/
    cherry.woff2
  bubbles/
    nine-slice.png
  emoji/
    wink.png
  pack.json        # 可选
```

识别规则（先看目录名，再看文件名，最后看扩展名）：

| 类型 | 目录 / 文件名关键词 | 允许的扩展名 |
| --- | --- | --- |
| 表情、贴纸 | `emoji` `emote` `sticker` `表情` `贴纸` | png / jpg / jpeg / webp / gif / svg |
| 图标 | `icon` `图标` | png / jpg / jpeg / webp / gif / svg（含 `.ico` 时可做托盘） |
| 字体 | `font` `字体` `字型` | woff / woff2 / ttf / otf |
| 气泡 | `bubble` `气泡` `对话` `dialogue` | png / jpg / jpeg / webp / gif / svg |

- 目录名优先，其次看文件名，认不出的图片不会硬塞进任何一类。
- 字体只要扩展名对就会归到 `font`，不必放在 `fonts/` 里。
- `README.md`、`LICENSE` 之类的附带文件会被跳过，不会导致整包失败。
- 压缩包里出现 `.moc3`、`.model3.json`、`.motion3.json`、`.physics3.json` 会直接拒绝整包 —— Live2D 模型请走立绘导入。

## pack.json（可选）

有 `pack.json` 时优先读里面的声明，文件仍按实际路径分类：

```json
{
  "name": "樱花气泡",
  "version": "1.0.0",
  "author": "柒柒",
  "license": "自制，允许随桌宠一起分发",
  "kinds": ["icon", "font", "bubble", "emoji"],
  "fonts": [{ "file": "fonts/cherry.woff2", "family": "Cherry Bubble" }],
  "bubble": { "file": "bubbles/nine-slice.png", "slice": 18 }
}
```

- `name` 为空时用包目录名。
- `bubble.slice` 是九宫格四角不拉伸的边长，设置页里还能再改（4 ~ 64 px）。
- 解析失败不会让包消失，界面上会用目录推断结果并保留错误原因。

## 安全与体积

- 总量上限 128 MB，单文件 16 MB，目录深度最多 6 层。
- 绝对路径、`..` 穿越段、以 `/` 开头的条目一律拒绝（zip slip 防线）。
- `__MACOSX`、`.DS_Store`、`Thumbs.db` 自动跳过。
- 重名包目录自动加 `-2`、`-3`，不会覆盖已导入的包。
- 文件落在 Electron `userData/packs/<包 id>/`，渲染侧只能通过 `pet-media://pack/<id>/<相对路径>` 读取，拿不到真实绝对路径。

## 内置素材包

安装包自带 `assets/packs/<目录名>/`，目录结构与导入包完全一致，同样认 `pack.json`。

- 识别后的 id 是 `builtin-<目录名>`，在设置里单独成组，排在导入包前面。
- 随应用分发，只读：不提供停用开关，也不能删除。
- 目录不存在时整组不显示，不会留一个空栏。
- 读取同样走 `pet-media://pack/<id>/<相对路径>`，协议层按 id 前缀分流到内置根，越界仍会被拒。

## 设置里的引用格式

设置保存的是 `pack:<id>:<相对路径>`，例如：

```
pack:樱花气泡/:icons/tray.ico
```

长度上限 256；前导 `/`、`..`、反斜杠都会被判为非法并清空。

| 设置字段 | 用途 |
| --- | --- |
| `icon.tray` | 托盘图标 |
| `icon.app` | 窗口与任务栏图标 |
| `bubble.background` | 气泡底图（九宫格拉伸） |
| `bubble.backgroundSlice` | 底图切片，4 ~ 64 px，默认 12 |
| `bubble.fontFamily` | 气泡字体（woff2 / ttf 等） |
| `sticker.source` | 气泡旁贴纸（固定右上角，56 px，不挡鼠标） |

## 生效方式

- **图标**：保存后立即换托盘图，并给所有已打开窗口重设图标；托盘读取失败时保留旧图标，不会让托盘消失。
- **气泡底图**：用 `border-image` 做九宫格，选空时把 border 宽度收回 0，恢复原来的纯色气泡。
- **字体**：运行时注册 `FontFace`，加载完成后整条气泡字体栈切换；加载失败回退内置字体，不阻塞气泡显示。
- **贴纸**：挂载在主窗口 shadow 里，`pointer-events: none`，不会拦截点击。

## 删除素材包

设置页每个包右侧有「删除」。删除时会把所有以 `pack:<id>:` 开头的引用一起清空（图标、气泡底图、字体、贴纸），写盘后广播给所有窗口，不需要重启。
