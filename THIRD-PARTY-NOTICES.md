# 第三方声明

本仓库的运行时依赖与构建工具全部使用开源许可。随包分发时保留本文件即可满足署名要求。

## 运行时依赖

| 依赖 | 版本范围 | 许可证 | 用途 |
| --- | --- | --- | --- |
| pixi.js | ^6.5.10 | MIT | Live2D 渲染底座 |
| pixi-live2d-display | 0.4.0 | MIT | Cubism 模型显示 |
| @pixi/unsafe-eval | 6.5.10 | MIT | PIXI 在 Electron 受限环境下的兼容层 |
| adm-zip | 0.5.16 | MIT | 导入模型压缩包 |

## 构建与测试工具

| 依赖 | 版本范围 | 许可证 |
| --- | --- | --- |
| @types/node | ^22.10.2 | MIT |
| electron | ^33.4.11 | MIT |
| electron-builder | ^26.18.0 | MIT |
| typescript | ^5.7.2 | Apache-2.0 |
| vitest | ^5.0.5 | MIT |

## 素材

随包素材的授权与使用边界见 `assets/ATTRIBUTION.md`。素材不按第三方许可分发。

## 维护方式

`scripts/check-third-party.mjs` 会读根 `package.json` 的依赖清单，逐个核对本文件是否列出，并核对 `node_modules` 里实际的 `license` 字段。新增依赖前先补一行，否则门禁失败。
