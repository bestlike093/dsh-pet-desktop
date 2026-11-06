# dyad-petal

双宿主骨架包。同一目录，两个入口，共享一份内核。

```
dyad-petal/
  manifest.json   Cyrene 清单 → entry: index.cjs
  petal.json      dsh 清单    → entry: index.mjs
  index.cjs       Cyrene 形态：register / unregister
  index.mjs       dsh 形态：meta / bootstrap / teardown
  core.cjs        共享内核，零宿主依赖
```

## 已验证

`node scripts/check-petal-bundle.mjs`（已接入 `pnpm verify`）：

- 两份清单的 id / version 一致，entry 都存在且不越界
- Cyrene 入口能 `require`，导出 `register` / `unregister`
- dsh 入口能 `import`，具名与 default 两套导出都完整
- `index.mjs` 能直接 `import` 同目录的 `.cjs`（Node ESM → CJS 互操作成立）
- 两个入口拿到的是同一份内核实例（一侧写入，另一侧读得到）

## 未验证

- **Cyrene 真实加载**：需要把目录放进 `%APPDATA%\Cyrene\plugins\` 并重启宿主才生效，验证脚本不碰宿主进程。
- **dsh 真实加载**：`packages/core/src/modules/moduleLoader.ts` 目前是 `registry` 模式，只有静态注册表与首次实例化，没有从磁盘读 `petal.json` 的装机通道。`petal.json` 规范已经定好，加载器还没有落地。所以 dsh 侧目前只能验证「入口形态合法」，验证不了「装上就能跑」。

## 边界

内核里只放与宿主无关的逻辑。两套生命周期差异留在各自入口，避免把一侧的形状带进另一侧。新增能力时先问：这段逻辑知不知道自己在哪个宿主里跑？知道，就写进入口；不知道，才进 core。
