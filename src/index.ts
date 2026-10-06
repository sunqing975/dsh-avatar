import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { parseBlendShapesFromGlb } from './model-info.ts'
import { Config, type Config as ConfigType } from './config.ts'
import { PoseHub } from './pose.ts'
import { registerExpressionTool, registerMotionTool } from './tools.ts'
import {
  AssetRegistry,
  MAX_MODEL_BYTES,
  MAX_MOTION_BYTES,
  type AssetRef,
} from './assets-registry.ts'

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

/** info 端点的响应：资产清单 + 当前模型 + 工具所需信息，client 页面与浮层共用。 */
interface AssetInfo {
  currentModel: string
  models: AssetRef[]
  /** 当前模型的 blend shapes（set_expression 的 enum）。 */
  blendShapes: string[]
  /** 当前模型的可访问 URL（带 mtime 版本戳，浏览器不缓存旧模型）。 */
  modelUrl: string
  animations: AssetRef[]
}

export function apply(ctx: Context, config: ConfigType): void {
  const registry = new AssetRegistry(packageRoot, config.modelPath)
  const hub = new PoseHub()

  // 工具 disposer：热更新时先卸载旧工具再用新 enum 重新注册。
  let expressionDisposer: (() => void) | null = null
  let motionDisposer: (() => void) | null = null

  /** 以当前模型的表情 enum 重新注册 set_expression。 */
  async function refreshExpressionTool(): Promise<void> {
    expressionDisposer?.()
    expressionDisposer = null
    try {
      const current = await registry.currentModel()
      const file = await registry.modelFile(current)
      if (!file) {
        ctx.logger?.warn?.('[dsh-avatar] current model file missing: %s', current)
        return
      }
      const data = await readFile(file)
      const blendShapes = parseBlendShapesFromGlb(
        data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
      )
      if (blendShapes.length === 0) {
        ctx.logger?.warn?.('[dsh-avatar] model %s has no blend shapes; set_expression not registered', current)
        return
      }
      expressionDisposer = registerExpressionTool(ctx, blendShapes, hub)
      ctx.logger?.info?.('[dsh-avatar] set_expression updated (%d): %s', blendShapes.length, blendShapes.map(s => s.id).join(', '))
    } catch (err) {
      ctx.logger?.warn?.('[dsh-avatar] failed to refresh set_expression: %s', err instanceof Error ? err.message : err)
    }
  }

  /** 以当前动作清单重新注册 play_motion。 */
  async function refreshMotionTool(): Promise<void> {
    motionDisposer?.()
    motionDisposer = null
    try {
      const animations = await registry.listAnimations()
      if (animations.length === 0) {
        ctx.logger?.warn?.('[dsh-avatar] no vrma animations found; play_motion not registered')
        return
      }
      motionDisposer = registerMotionTool(ctx, animations.map(a => a.name), hub)
      ctx.logger?.info?.('[dsh-avatar] play_motion updated (%d): %s', animations.length, animations.map(a => a.name).join(', '))
    } catch (err) {
      ctx.logger?.warn?.('[dsh-avatar] failed to refresh play_motion: %s', err instanceof Error ? err.message : err)
    }
  }

  /** 组装 info 响应（模型 URL 带 mtime 版本戳）。 */
  async function buildInfo(): Promise<AssetInfo> {
    const [current, models, animations, modelPath] = await Promise.all([
      registry.currentModel(),
      registry.listModels(),
      registry.listAnimations(),
      registry.modelFile(await registry.currentModel()),
    ])
    let modelUrl = config.modelUrl
    try {
      if (modelPath) {
        const st = await stat(modelPath)
        modelUrl = `${config.modelUrl}?v=${st.mtimeMs}`
      }
    } catch {
      // 保持无版本 URL。
    }
    let blendShapes: string[] = []
    try {
      if (modelPath) {
        const data = await readFile(modelPath)
        blendShapes = parseBlendShapesFromGlb(
          data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
        ).map(s => s.id)
      }
    } catch (err) {
      ctx.logger?.warn?.('[dsh-avatar] buildInfo blendShapes failed: %s', err instanceof Error ? err.message : err)
    }
    return { currentModel: current, models, blendShapes, modelUrl, animations }
  }

  function sendJson(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify(body))
  }

  /** 读取请求体，超过上限拒绝（上传文件的接收器）。 */
  function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      let total = 0
      req.on('data', (chunk: Buffer) => {
        total += chunk.length
        if (total > maxBytes) {
          reject(new Error(`upload too large (> ${Math.round(maxBytes / 1024 / 1024)}MB)`))
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => resolve(Buffer.concat(chunks)))
      req.on('error', reject)
    })
  }

  // 当前模型服务：把生效中的 VRM 文件以 HTTP 形式提供给浏览器渲染。
  ctx.webServer.register({
    kind: 'exact',
    path: config.modelUrl,
    handler: async (_req, res) => {
      try {
        const file = await registry.modelFile(await registry.currentModel())
        if (!file) throw new Error('no model available')
        const data = await readFile(file)
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

  // 动作服务：用户目录优先，其次内置 assets/animations。
  // （旧路径 /dsh-avatar/assets 保留服务内置静态资源，兼容手动往包里放文件的用法。）
  ctx.webServer.register({
    kind: 'prefix',
    path: '/dsh-avatar/animations',
    handler: async (req, res) => {
      try {
        const rel = decodeURIComponent(((req.url ?? '').split('?')[0] ?? '').replace(/^\/dsh-avatar\/animations\//, ''))
        const name = rel.replace(/\.vrma$/i, '')
        const file = await registry.animationFile(name)
        if (!file) throw new Error('not found')
        const data = await readFile(file)
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': data.length,
          'Cache-Control': 'no-store',
        })
        res.end(data)
      } catch (err) {
        ctx.logger?.warn?.('[dsh-avatar] failed to serve animation: %s', err instanceof Error ? err.message : err)
        res.writeHead(404, { 'Content-Type': 'text/plain' })
        res.end('animation not found')
      }
    },
  })

  // 内置静态资源：assets 目录（模型 + 动作）以 HTTP 形式提供给浏览器。
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
        res.writeHead(200, {
          'Content-Type': ext === '.vrm' ? 'model/gltf-binary' : 'application/octet-stream',
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

  // 元信息端点：资产清单 + 当前模型信息，管理页与数字人浮层共用。
  ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-avatar/info',
    handler: async (_req, res) => {
      try {
        sendJson(res, 200, await buildInfo())
      } catch (err) {
        sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
      }
    },
  })

  // 指令桥端点：浏览器侧的客户端插件拿不到 Host 的 session/event，
  // 因此改由「工具写入 → 客户端轮询」传递表情/动作指令。
  ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-avatar/pose',
    handler: (req, res) => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const parsed = Number.parseInt(url.searchParams.get('since') ?? '0', 10)
        const since = Number.isFinite(parsed) && parsed > 0 ? parsed : 0
        sendJson(res, 200, hub.read(since))
      } catch (err) {
        sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
      }
    },
  })

  // 上传端点：POST /dsh-avatar/upload?kind=model|motion&name=<文件名>，body 为原始 GLB 字节。
  // 成功后工具 enum 热更新，响应返回最新资产清单。
  ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-avatar/upload',
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'POST required' })
        return
      }
      try {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const kind = url.searchParams.get('kind')
        const filename = url.searchParams.get('name') ?? ''
        const maxBytes = kind === 'model' ? MAX_MODEL_BYTES : kind === 'motion' ? MAX_MOTION_BYTES : 0
        if (maxBytes === 0) {
          sendJson(res, 400, { error: 'kind must be model or motion' })
          return
        }
        const body = await readBody(req, maxBytes)
        if (body.length === 0) {
          sendJson(res, 400, { error: 'empty body' })
          return
        }
        if (kind === 'model') {
          if (!filename.toLowerCase().endsWith('.vrm')) {
            sendJson(res, 400, { error: 'model upload must be .vrm' })
            return
          }
          const name = await registry.importModel(body, filename)
          await refreshExpressionTool()
          ctx.logger?.info?.('[dsh-avatar] imported model: %s', name)
          sendJson(res, 200, { ok: true, name, info: await buildInfo() })
        } else {
          if (!filename.toLowerCase().endsWith('.vrma')) {
            sendJson(res, 400, { error: 'motion upload must be .vrma' })
            return
          }
          const name = await registry.importAnimation(body, filename)
          await refreshMotionTool()
          ctx.logger?.info?.('[dsh-avatar] imported animation: %s', name)
          sendJson(res, 200, { ok: true, name, info: await buildInfo() })
        }
      } catch (err) {
        ctx.logger?.warn?.('[dsh-avatar] upload failed: %s', err instanceof Error ? err.message : err)
        sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) })
      }
    },
  })

  // 切换当前模型：POST /dsh-avatar/select-model，body { "name": "<模型名>" }。
  ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-avatar/select-model',
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'POST required' })
        return
      }
      try {
        const body = await readBody(req, 64 * 1024)
        const parsed = JSON.parse(body.toString('utf8')) as { name?: unknown }
        if (typeof parsed.name !== 'string' || parsed.name === '') {
          sendJson(res, 400, { error: 'name required' })
          return
        }
        await registry.setCurrentModel(parsed.name)
        await refreshExpressionTool()
        ctx.logger?.info?.('[dsh-avatar] current model switched to: %s', parsed.name)
        sendJson(res, 200, { ok: true, info: await buildInfo() })
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) })
      }
    },
  })

  // 删除用户导入的资产：POST /dsh-avatar/delete?kind=model|motion&name=<资产名>。
  ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-avatar/delete',
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'POST required' })
        return
      }
      try {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const kind = url.searchParams.get('kind')
        const name = url.searchParams.get('name') ?? ''
        if ((kind !== 'model' && kind !== 'motion') || name === '') {
          sendJson(res, 400, { error: 'kind and name required' })
          return
        }
        if (kind === 'model') {
          const currentWasRemoved = await registry.removeModel(name)
          await refreshExpressionTool()
          ctx.logger?.info?.('[dsh-avatar] removed model: %s', name)
          sendJson(res, 200, { ok: true, currentChanged: currentWasRemoved, info: await buildInfo() })
        } else {
          const removed = await registry.removeAnimation(name)
          await refreshMotionTool()
          ctx.logger?.info?.('[dsh-avatar] removed animation: %s', name)
          sendJson(res, 200, { ok: true, removed, info: await buildInfo() })
        }
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) })
      }
    },
  })

  // 启动时注册工具（解析模型 blend shapes + 扫描动作）。
  void refreshExpressionTool()
  void refreshMotionTool()

  // 插件卸载时一并卸载工具。
  ctx.effect(() => () => {
    expressionDisposer?.()
    motionDisposer?.()
    expressionDisposer = null
    motionDisposer = null
  })
}
