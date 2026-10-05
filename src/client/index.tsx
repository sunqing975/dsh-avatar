import type { ComponentType } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { AvatarFloating } from './AvatarFloating.tsx'
import { emitExpression, emitMotion } from './event-bus.ts'

/**
 * 本地声明 slots 服务的最小类型。
 * npm 上的 @deepseek-ai/dsh-client-ui-renderer 因缺 @deepseek-ai/dsh-paths 无法安装，
 * 因此不依赖其声明，直接对齐本地 deepseek-harness checkout 的 ui-slots API。
 */
declare module '@deepseek-ai/cordis' {
  interface Context {
    slots: {
      /** 等待并注入一个 slot 条目（factory 在声明生命周期内运行）。 */
      inject(key: string, factory: () => () => void): () => void
      /** 注册一个渲染贡献，返回 disposer。 */
      register(
        options: {
          name: string
          key?: string
          id?: string
          order?: number
        },
        component: ComponentType,
      ): () => void
    }
  }
}

export const name = 'dsh-avatar-client'
export const inject = ['slots']

export function apply(ctx: Context): void {
  try {
    // 注册数字人常驻浮层到 dsh 全局前层（shell.overlay）：
    // 所有页面/会话常驻可见，不占用任何 tab。
    ctx.effect(() => ctx.slots.inject('shell.overlay', () => {
      try {
        return ctx.slots.register({
          name: 'shell.overlay',
          id: 'dsh-avatar',
        }, AvatarFloating)
      } catch (err) {
        // HMR 热重载时旧注册可能未及时释放，已注册则跳过。
        if (err instanceof Error && err.message.includes('already registered')) {
          return () => {}
        }
        throw err
      }
    }))

    // 事件链路：监听 session 日志里的 tool/result，命中表情/动作工具则驱动数字人。
    ctx.on('session/event', (_session, event: SessionEvent) => {
      if (event.type !== 'tool/result') return
      const message = event.data.message as { name?: string; arguments?: string }
      if (message.name === 'set_expression') {
        try {
          const args = JSON.parse(message.arguments ?? '{}') as { expression?: unknown }
          if (typeof args.expression === 'string' && args.expression.length > 0) {
            emitExpression(args.expression)
          }
        } catch {
          // 参数是模型原始输出，解析失败时忽略。
        }
        return
      }
      if (message.name === 'play_motion') {
        try {
          const args = JSON.parse(message.arguments ?? '{}') as { motion?: unknown }
          if (typeof args.motion === 'string' && args.motion.length > 0) {
            emitMotion(args.motion)
          }
        } catch {
          // 参数是模型原始输出，解析失败时忽略。
        }
      }
    })
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[dsh-avatar] client apply failed:', err)
  }
}
