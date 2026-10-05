import type { ComponentType } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { AvatarBody, AvatarTitle } from './AvatarPanel.tsx'
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
export const inject = ['slots', 'sidebarRightTabs', 'sidebarRight']

const TAB_ID = 'dsh-avatar'
const TAB_KIND = 'dsh-avatar'

export function apply(ctx: Context): void {
  try {
    // 阶段一：注册右栏 tab 类型（页面型，按 kind 打开）。
    ctx.effect(() => {
      try {
        return ctx.sidebarRightTabs.register({
          id: TAB_ID,
          kind: TAB_KIND,
          priority: 'extension',
          title: () => '数字人',
        })
      } catch (err) {
        // HMR 热重载时旧注册可能未及时释放，已注册则跳过。
        if (err instanceof Error && err.message.includes('already registered')) {
          return () => {}
        }
        throw err
      }
    })

    // 阶段二：tab body（数字人面板）注册到 keyed seat。
    ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () =>
      ctx.slots.register({
        name: 'sidebar.right.pane.tab',
        key: TAB_KIND,
      }, AvatarBody),
    ))

    // 阶段三：tab chip 标题。
    ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () =>
      ctx.slots.register(
        { name: 'sidebar.right.pane.tab.title', key: TAB_KIND },
        AvatarTitle,
      ),
    ))

    // 阶段四：打开数字人 tab（右栏 tab 栏只显示已打开/导航过的 tab）。
    // openTab 需要右栏 seat 挂载（会话激活后），轮询重试直到成功。
    ctx.effect(() => {
      const interval = setInterval(() => {
        try {
          ctx.sidebarRight.openTab(TAB_KIND, { revealIfOpened: true })
          clearInterval(interval)
        } catch (err) {
          // 'no session surface is mounted'：会话未激活，继续等。
          // 'already registered'：HMR 残留，放弃。
          if (err instanceof Error && err.message.includes('already registered')) {
            clearInterval(interval)
          }
        }
      }, 800)
      return () => clearInterval(interval)
    })

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
