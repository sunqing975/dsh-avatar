import type { ComponentType } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { AvatarFloating } from './AvatarFloating.tsx'
import { AssetManagerPanel } from './AssetManagerPanel.tsx'
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
    /** 右侧边栏 tab 类型注册表（dsh-client-ui-sidebar-right 提供；宿主未装时不存在）。 */
    sidebarRightTabs?: {
      register(definition: {
        /** 实现身份，全局唯一，也是正文 slot 的 key。 */
        id: string
        /** 页面类型判别名，openTab(kind) 用它打开。 */
        kind: string
        /** tab chip 文案（每次读取，支持语言切换）。 */
        title: (address: string) => string
        /** 引导页入口（可选）。 */
        guide?: ReadonlyArray<{
          order: number
          title: () => string
          description: () => string
        }>
      }): () => void
    }
  }
}

export const name = 'dsh-avatar-client'
export const inject = ['slots']

/** 轮询间隔：对「对话里顺带做个动作」的体感足够，开销是一次数百字节的 GET。 */
const POLL_INTERVAL_MS = 400

/** 管理页 tab 的类型 id / kind / slot key（三处共用同一标识）。 */
export const ASSET_TAB_ID = 'dsh-avatar-assets'

/**
 * 资产条目归一化 + 动作 URL 拼装（实现在 assets.ts，浮层 vrm.ts 用同一份）。
 * 这里再导出一次，让 verify 脚本能对「构建产物里的同一份实现」做断言：
 * Host 发 `{name, builtin}`、客户端按裸字符串处理时，动作 URL 会变成
 * `%5Bobject%20Object%5D.vrma` → 全部 404 → clips 为空、没有 idle、数字人僵在 bind pose。
 */
export { assetNames, motionUrl } from './assets.ts'

/**
 * 待机动作的放大/程序化组装（实现在 idle-motion.ts，vrm.ts 用同一份）。
 * 同样导出给 verify 脚本做纯函数断言（幅度放大后偏差必须变大、首尾必须相等）。
 */
export { amplifyClip, buildIdleClip, pickIdleMotion, IDLE_GAIN, IDLE_MOTION_PREFERENCE } from './idle-motion.ts'

/** 浮层拖拽的视口夹取（实现在 drag.ts，AvatarFloating 用同一份）。导出给 verify 做纯函数断言。 */
export { clampToViewport } from './drag.ts'

/** 统一日志通道：同时写 console 与 window.__dshAvatarLog（排查用）。 */
export function log(line: string): void {
  const w = window as unknown as { __dshAvatarLog?: string[] }
  w.__dshAvatarLog = w.__dshAvatarLog ?? []
  w.__dshAvatarLog.push(line)
  // eslint-disable-next-line no-console
  console.log('[dsh-avatar]', line)
}

/**
 * 三个能力各自独立兜底：任何一段注册失败都不允许拖垮另外两段。
 */
function safe(label: string, fn: () => void): void {
  try {
    fn()
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[dsh-avatar] client ${label} 注册失败：`, err)
  }
}

export function apply(ctx: Context): void {
  safe('常驻浮层', () => registerOverlay(ctx))
  safe('指令链路', () => registerPoseBridge(ctx))
  safe('管理页 tab', () => registerAssetTab(ctx))
}

function registerOverlay(ctx: Context): void {
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
}

/**
 * 管理页：右侧边栏 tab（两阶段注册：类型 + 正文）。
 *
 * ⚠️ 不能用 `ctx.sidebarRightTabs` 直接读：Cordis 的服务只能从「本插件 inject 过的名字」
 * 解析，未 inject 的属性读取会被 proxy 的 get trap 直接 throw
 * `cannot get property "sidebarRightTabs" without inject` —— 可选链 `?.` 挡不住 throw，
 * 一旦抛出会中断整个 apply（连带指令链路一起失效，表现为「工具能调、数字人不动」）。
 *
 * 正确姿势是 `ctx.inject(['…'], cb)`：服务可用后回调才跑，宿主没提供该服务时回调永不执行，
 * 天然降级（浮层与指令链路不受影响）。回调里的 ctx 已把服务解析进自己的 store，可以安全直读。
 */
function registerAssetTab(ctx: Context): void {
  ctx.inject(['sidebarRightTabs'], (tabCtx: Context) => {
    const tabs = tabCtx.sidebarRightTabs
    if (!tabs) return
    const tabTypeDisposer = tabs.register({
      id: ASSET_TAB_ID,
      kind: ASSET_TAB_ID,
      title: () => '数字人',
      guide: [{
        order: 100,
        title: () => '数字人资产管理',
        description: () => '导入 VRM 模型与 VRMA 动作，工具参数实时更新',
      }],
    })
    const tabBodyDisposer = tabCtx.slots.register({
      name: 'sidebar.right.pane.tab',
      key: ASSET_TAB_ID,
    }, AssetManagerPanel)
    tabCtx.effect(() => () => {
      tabTypeDisposer()
      tabBodyDisposer()
    })
    log(`tab registered id=${ASSET_TAB_ID}`)
  })
}

function registerPoseBridge(ctx: Context): void {
  // 指令链路：轮询 Host 侧的 /dsh-avatar/pose，按 seq 差分出新指令后驱动数字人。
  //
  // 为什么不用 `ctx.on('session/event')`：那是 Host 侧 Session 服务上的 Cordis 事件，
  // 浏览器里的客户端插件收不到——扫遍所有 client bundle 没有任何一个把它转发过来，
  // 所以那个监听器永远不会触发（工具返回成功、数字人毫无反应）。
  // 改由插件自己建通路：工具 execute 写入 PoseHub，这里轮询取增量。
  ctx.effect(() => {
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
}
