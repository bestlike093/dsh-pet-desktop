# 设计 token（2026-11-02）

> 唯一来源：`apps/desktop/electron/renderer/theme.css`。
> 样式文件只引用 `var(--...)`，不写具体色值；`check-hex-colors --strict` 的裸用必须为 0。

## 分组

| 组 | token | 用途 |
| --- | --- | --- |
| 主色 | `--accent` / `--accent-deep` / `--accent-soft` / `--accent-line` | 强调、选中、描边 |
| 表面 | `--surface` / `--surface-soft` / `--surface-solid` / `--line` | 卡片、输入框、分隔线 |
| 文字 | `--ink` / `--muted` | 正文、次要说明 |
| 页面 | `--page-from` / `--page-to` / `--switch-track` | 窗口底色、开关轨道 |
| 语义 | `--danger` | 错误、危险操作、写满提示 |
| 状态 | `--disabled-opacity` / `--disabled-opacity-strong` | 禁用与不可操作态 |

## 口径

- **禁用态**：普通控件（按钮、输入、选择器）用 `--disabled-opacity`（0.5）；引导页主按钮用 `--disabled-opacity-strong`（0.6）。禁用只降透明度，不换颜色。
- **字数计数**：`>= 90%` 用 `--accent-deep`（`.is-near`）；写满 `>= 100%` 用 `--danger`（`.is-full`）。只做视觉提示，不拦截输入。
- **图表**：`--chart-*` 标记为 **reserved**，当前不定义；出现图表视图时按系列补 token，不在组件里写色值。
- **主题覆盖**：三套主题（默认 / pink / ink）只覆盖主色、表面、页面与气泡组；语义与状态 token 固定在 `:root`，不随主题变。
