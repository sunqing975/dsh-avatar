import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { parseBlendShapesFromGlb } from './model-info.ts'
import { Config, type Config as ConfigType } from './config.ts'
import { PoseHub } from './pose.ts'
import { registerExpressionTool, registerMotionTool } from './tools.ts'

/**
 * 本地声明 dsh-host-webserver 的服务类型。
 * npm 发布的 rc 版本服务名是 httpServer，本地 checkout 是 webServer——预览期漂移，
 * 因此不依赖 npm 包，直接对齐本项目目标运行时（本地 deepseek-harness checkout）。
 */
declare module '@deepseek-ai/cordis' {
  interface Context {
    webServer: {
      register(route: WebRoute): () => void
    }
  }
}

interface WebRoute {
  kind: 'exact' | 'prefix'
  /** Absolute pathname, no trailing slash. */
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

export { Config }
export type { ConfigType }

export const name = 'dsh-avatar'
export const inject = ['tools', 'webServer']

/** 插件包根目录（lib/index.js 的上一级）。 */
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export function apply(ctx: Context, config: ConfigType): void {
  const modelPath = path.resolve(packageRoot, config.modelPath)
  const hub = new PoseHub()

  // 模型服务：把 VRM 文件以 HTTP 形式提供给浏览器渲染。
  ctx.webServer.register({
    kind: 'exact',
    path: config.modelUrl,
    handler: async (_req, res) => {
      try {
        const data = await readFile(modelPath)
        res.writeHead(200, {
          'Content-Type': 'model/gltf-binary',
          'Content-Length': data.length,
          'Cache-Control': 'no-store',
        })
        res.end(data)
      } catch (err) {
        ctx.logger?.warn?.('[dsh-avatar] failed to serve model: %s', err instanceof Error ? err.message : err)
        res.writeHead(404, { 'Content-Type': 'text/plain' })
        res.end('model not found')
      }
    },
  })

  // 静态资源：assets 目录（模型 + 动作）以 HTTP 形式提供给浏览器。
  // 仅允许 assets 内的文件，防路径穿越。
  const assetsRoot = path.resolve(packageRoot, 'assets')
  ctx.webServer.register({
    kind: 'prefix',
    path: '/dsh-avatar/assets',
    handler: async (req, res) => {
      try {
        const rel = decodeURIComponent(((req.url ?? '').split('?')[0] ?? '').replace(/^\/dsh-avatar\/assets\//, ''))
        const target = path.resolve(assetsRoot, rel)
        if (!target.startsWith(assetsRoot + path.sep)) {
          res.writeHead(403, { 'Content-Type': 'text/plain' })
          res.end('forbidden')
          return
        }
        const data = await readFile(target)
        const ext = path.extname(target).toLowerCase()
        const contentType = ext === '.vrm'
          ? 'model/gltf-binary'
          : ext === '.vrma'
            ? 'application/octet-stream'
            : 'application/octet-stream'
        res.writeHead(200, {
          'Content-Type': contentType,
          'Content-Length': data.length,
          'Cache-Control': 'no-store',
        })
        res.end(data)
      } catch (err) {
        ctx.logger?.warn?.('[dsh-avatar] failed to serve asset: %s', err instanceof Error ? err.message : err)
        res.writeHead(404, { 'Content-Type': 'text/plain' })
        res.end('asset not found')
      }
    },
  })

  // 元信息端点：client 启动时可校验模型/表情/动作清单。
  ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-avatar/info',
    handler: async (_req, res) => {
      try {
        const data = await readFile(modelPath)
        const blendShapes = parseBlendShapesFromGlb(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength))
        const animations = (await readdir(path.join(assetsRoot, 'animations')))
          .filter(f => f.toLowerCase().endsWith('.vrma'))
          .map(f => f.replace(/\.vrma$/i, ''))
          .sort()
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
        res.end(JSON.stringify({
          modelUrl: config.modelUrl,
          blendShapes: blendShapes.map(s => s.id),
          animations,
        }))
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }))
      }
    },
  })

  // 指令桥端点：浏览器侧的客户端插件拿不到 Host 的 session/event，
  // 因此改由「工具写入 → 客户端轮询」传递表情/动作指令。
  // `?since=<seq>` 返回水位线之后的新指令（始终带当前 seq，无新指令时 commands 为空数组）。
  // 旧版这里用 null 表示「无新指令」，会让客户端永远建不起水位线、吞掉第一条指令——语义见 pose.ts 顶部说明。
  ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-avatar/pose',
    handler: (req, res) => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const parsed = Number.parseInt(url.searchParams.get('since') ?? '0', 10)
        const since = Number.isFinite(parsed) && parsed > 0 ? parsed : 0
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
        res.end(JSON.stringify(hub.read(since)))
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }))
      }
    },
  })

  // 表情工具：动态 enum 来自当前 VRM 模型的 blend shapes。
  // apply 内同步读完模型；解析失败则不注册工具并告警（避免 LLM 拿到空 enum）。
  void (async () => {
    try {
      const data = await readFile(modelPath)
      const blendShapes = parseBlendShapesFromGlb(
        data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
      )
      if (blendShapes.length === 0) {
        ctx.logger?.warn?.('[dsh-avatar] model has no blend shapes; set_expression not registered')
        return
      }
      registerExpressionTool(ctx, blendShapes, hub)
      ctx.logger?.info?.('[dsh-avatar] registered set_expression with %d expressions: %s', blendShapes.length, blendShapes.map(s => s.id).join(', '))
    } catch (err) {
      ctx.logger?.warn?.('[dsh-avatar] failed to parse model at %s: %s (set_expression NOT registered)', modelPath, err instanceof Error ? err.message : err)
    }
  })()

  // 动作工具：enum 来自 assets/animations 目录扫描（动态，用户可随时往里加 VRMA）。
  void (async () => {
    try {
      const animations = (await readdir(path.join(assetsRoot, 'animations')))
        .filter(f => f.toLowerCase().endsWith('.vrma'))
        .map(f => f.replace(/\.vrma$/i, ''))
        .sort()
      if (animations.length === 0) {
        ctx.logger?.warn?.('[dsh-avatar] no vrma animations found; play_motion not registered')
        return
      }
      registerMotionTool(ctx, animations, hub)
      ctx.logger?.info?.('[dsh-avatar] registered play_motion with %d motions: %s', animations.length, animations.join(', '))
    } catch (err) {
      ctx.logger?.warn?.('[dsh-avatar] failed to scan animations: %s (play_motion NOT registered)', err instanceof Error ? err.message : err)
    }
  })()
}
