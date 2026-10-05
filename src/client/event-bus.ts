/**
 * client 侧内部事件总线：工具结果事件 → 数字人播放指令。
 * 模块级单例，AvatarPanel 订阅，插件入口发布。
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
