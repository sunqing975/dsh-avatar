/**
 * client 侧内部事件总线：工具结果事件 → 数字人播放指令；资产变更 → 数字人重载。
 * 模块级单例，AvatarPanel / 管理页发布，AvatarFloating 订阅。
 */

export const avatarEvents = new EventTarget()

export interface ExpressionDetail {
  expression: string
}

export interface MotionDetail {
  motion: string
}

export function emitExpression(expression: string): void {
  avatarEvents.dispatchEvent(new CustomEvent<ExpressionDetail>('expression', { detail: { expression } }))
}

export function emitMotion(motion: string): void {
  avatarEvents.dispatchEvent(new CustomEvent<MotionDetail>('motion', { detail: { motion } }))
}

/**
 * 资产变更（导入/切换/删除模型或动作）：数字人浮层监听后重载模型与动作。
 */
export function emitAssetsChanged(): void {
  avatarEvents.dispatchEvent(new CustomEvent('assets-changed'))
}
