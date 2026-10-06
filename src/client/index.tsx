import type { ComponentType } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { AvatarFloating } from './AvatarFloating.tsx'
import { emitExpression, emitMotion } from './event-bus.ts'
import type { PoseFeed } from '../pose.ts'

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

/** 轮询间隔：对「对话里顺带做个动作」的体感足够，开销是一次数百字节的 GET。 */
const POLL_INTERVAL_MS = 400

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

    // 指令链路：轮询 Host 侧的 /dsh-avatar/pose，按 seq 差分出新指令后驱动数字人。
    //
    // 为什么不用 `ctx.on('session/event')`：那是 Host 侧 Session 服务上的 Cordis 事件，
    // 浏览器里的客户端插件收不到——扫遍所有 client bundle 没有任何一个把它转发过来，
    // 所以那个监听器永远不会触发（工具返回成功、数字人毫无反应）。
    // 改由插件自己建通路：工具 execute 写入 PoseHub，这里轮询取增量。
    ctx.effect(() => {
      const w = window as unknown as { __dshAvatarLog?: string[] }
      w.__dshAvatarLog = w.__dshAvatarLog ?? []
      const log = (line: string): void => {
        w.__dshAvatarLog?.push(line)
        // eslint-disable-next-line no-console
        console.log('[dsh-avatar]', line)
      }

      // 水位线：首次读到当前 seq 后只记录、不播放，避免挂载时重放历史指令。
      // 注意服务端**总是**返回水位线（无新指令时 commands 为空数组），
      // 所以这里第一轮就能建立水位线；若服务端用 null 表示「无新指令」，
      // 空队列时客户端永远建不起水位线，之后第一条真实指令会被当成水位线吞掉。
      let sinceSeq = -1
      let disposed = false
      let endpointMissingLogged = false

      void (async () => {
        while (!disposed) {
          await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS))
          if (disposed) return
          try {
            const res = await fetch(`/dsh-avatar/pose?since=${sinceSeq < 0 ? 0 : sinceSeq}`)
            if (!res.ok) {
              // 404 说明 Host 侧没有 pose 端点：装的是旧版插件（客户端版本领先于 Host）。
              // 这种「工具能调、数字人不动」正是旧版症状，必须显式告警而不是静默重试。
              if (res.status === 404 && !endpointMissingLogged) {
                endpointMissingLogged = true
                // eslint-disable-next-line no-console
                console.warn('[dsh-avatar] /dsh-avatar/pose 404：Host 侧插件缺少指令桥（多半是装了旧版 dsh-avatar），数字人不会响应工具调用。')
              }
              continue
            }
            endpointMissingLogged = false
            const feed = await res.json() as PoseFeed | null
            if (feed === null || typeof feed.seq !== 'number') continue
            const commands = Array.isArray(feed.commands) ? feed.commands : []
            // 首次拿到水位线：只建立水位线，不重放页面加载前产生的旧指令。
            if (sinceSeq < 0) {
              sinceSeq = feed.seq
              log(`baseline seq=${feed.seq}`)
              continue
            }
            sinceSeq = feed.seq
            for (const command of commands) {
              log(`pose seq=${command.seq} ${command.kind}=${command.value}`)
              if (command.kind === 'expression') emitExpression(command.value)
              else if (command.kind === 'motion') emitMotion(command.value)
            }
          } catch {
            // 瞬时网络失败：下一轮重试。
          }
        }
      })()

      return () => {
        disposed = true
      }
    })
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[dsh-avatar] client apply failed:', err)
  }
}
