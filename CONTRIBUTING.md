# Contributing

## 推送通道

本仓库默认**不使用** `git push` 推主线，也不使用 `git add -A`。

- 日常推送走 `%TEMP%\cyrene-api-push-next.mjs`（ssh-origin），逐条叠加提交，便于核对影响面。
- 只有出现历史分叉、且两边 tree 已被证明一致时，才申请**一次性** fast-forward 豁免；豁免用完即恢复脚本通道，并在 `docs/SSOT.md` 记录提交哈希。

### `git push` 没有 `--ff-only`

`--ff-only` 是 `git merge` / `git pull` 的选项，`git push` 不接受它：

```text
error: unknown option `ff-only'
```

想给推送加「只允许 fast-forward」的保护，用下面两步，不要照抄旧文档里的 `git push --ff-only`：

```bash
git merge-base --is-ancestor origin/main HEAD   # 断言远端是本地祖先，失败即停
git push --no-force origin main                 # 不带任何 force 变体
```

`git push` 本身就会拒绝非 fast-forward 更新，`--no-force` 只是把「不使用 force」写明白。

### 一次性豁免记录

| 日期 | 合并提交 | 新 origin/main | 说明 |
| --- | --- | --- | --- |
| 2026-11-02 | `987dd9c` | `987dd9c1053732a65711c00670c1d2da34fac2fb` | 合并远端历史，两树一致、files changed = 0；豁免已用完 |
