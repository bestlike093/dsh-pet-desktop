// 窗口边界计算（从 electron/main.mjs 迁出）。
//
// 这里只做坐标运算，workArea 由调用方从 screen 取好再注入，
// 避免把 native 副作用藏进「纯函数」标签里。

export interface WorkArea {
  x: number
  y: number
  width: number
  height: number
}

export interface Bounds extends WorkArea {}

export const DOCK_MARGIN = 24

export function clampBoundsToWorkArea(bounds: Bounds, area: WorkArea): Bounds {
  const width = Math.min(Math.max(1, Math.round(bounds.width)), area.width)
  const height = Math.min(Math.max(1, Math.round(bounds.height)), area.height)
  const x = Math.min(Math.max(Math.round(bounds.x), area.x), area.x + area.width - width)
  const y = Math.min(Math.max(Math.round(bounds.y), area.y), area.y + area.height - height)
  return { x, y, width, height }
}

export function dockBoundsToBottomRight(
  size: { width: number; height: number },
  area: WorkArea,
  margin: number = DOCK_MARGIN
): Bounds {
  const width = Math.min(Math.max(1, Math.round(size.width)), area.width)
  const height = Math.min(Math.max(1, Math.round(size.height)), area.height)
  return {
    x: area.x + area.width - width - margin,
    y: area.y + area.height - height - margin,
    width,
    height
  }
}
