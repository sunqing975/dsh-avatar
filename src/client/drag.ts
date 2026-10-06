/**
 * 浮层拖拽的边界夹取。
 *
 * 浮层是 `position: fixed`、尺寸固定（220×300），坐标直接用视口像素；
 * 早先的夹取下界写成了 `-WIDTH + 60`、右/下界写成 `innerWidth - 60`，
 * 等于允许把大半个人推出窗口之外（拖出去就看不见了）。
 *
 * 这里统一成「整个浮层必须完整落在视口内」，抽成纯函数便于单测（verify 直接断言）。
 */

/** 浮层在视口内的位置（fixed 定位的 left/top）。 */
export interface FloatingPosition {
  left: number
  top: number
}

/**
 * 把浮层位置夹进视口：`0 ≤ left ≤ viewportWidth - width`，top 同理。
 * 视口比浮层还小时（窄窗口）退化为贴左上角，不回传负值。
 */
export function clampToViewport(
  left: number,
  top: number,
  viewportWidth: number,
  viewportHeight: number,
  width: number,
  height: number,
): FloatingPosition {
  return {
    left: Math.min(Math.max(left, 0), Math.max(0, viewportWidth - width)),
    top: Math.min(Math.max(top, 0), Math.max(0, viewportHeight - height)),
  }
}
