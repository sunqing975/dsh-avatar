/**
 * 浮层拖拽的边界夹取。
 *
 * 浮层是 `position: fixed`、尺寸固定（220×300，见 AvatarFloating），坐标直接用视口像素。
 *
 * 两个坑：
 *   1. 边界必须按「整个浮层完整可见」算 —— 早先写成 `left ∈ [-WIDTH + 60, innerWidth - 60]`，
 *      等于允许把大半个人推出窗口之外。
 *   2. 但只夹「方框」又太紧：画布是 220×300，而站立的人物只有约 74px 宽（其余是透明空边），
 *      方框贴到窗口右边时，「人」看起来还离边框 70 多像素。所以要按人物本体在画布内的
 *      **透明边距**（`FloatingPadding`，运行时由 AvatarController 量出来）放宽边界：
 *      允许空画布溢出视口，但人物本体必须完整留在视口内。
 */

/** 浮层在视口内的位置（fixed 定位的 left/top）。 */
export interface FloatingPosition {
  left: number
  top: number
}

/** 人物本体相对画布的透明边距（px）：left 是人物左缘到画布左缘的距离，依此类推。 */
export interface FloatingPadding {
  left: number
  right: number
  top: number
  bottom: number
}

export const NO_PADDING: FloatingPadding = { left: 0, right: 0, top: 0, bottom: 0 }

/**
 * 把浮层位置夹进视口。
 *
 * @param padding 人物本体的透明边距；传 0 时等价于「整个方框留在视口内」。
 */
export function clampToViewport(
  left: number,
  top: number,
  viewportWidth: number,
  viewportHeight: number,
  width: number,
  height: number,
  padding: FloatingPadding = NO_PADDING,
): FloatingPosition {
  // 允许空画布溢出 padding，但人物本体的边缘不能越出视口。
  const maxLeft = Math.max(0, viewportWidth - width + padding.right)
  const minLeft = Math.min(-padding.left, maxLeft)
  const maxTop = Math.max(0, viewportHeight - height + padding.bottom)
  const minTop = Math.min(-padding.top, maxTop)
  return {
    left: Math.min(Math.max(left, minLeft), maxLeft),
    top: Math.min(Math.max(top, minTop), maxTop),
  }
}
