/**
 * 端到端验证「工具调用 → 浏览器侧数字人」这条链路。
 *
 * 三段真实拼装，不 mock 业务逻辑：
 *   1. 真的加载构建产物 lib/index.js（Host 插件），用最小 ctx 捕获注册的 HTTP 路由与工具。
 *   2. 真的起一个 node:http 服务，按 Host 注册的路由分发（等价于 dsh webServer）。
 *   3. 真的加载构建产物 lib/client.js（浏览器 bundle），用最小 window/__ModuleLoader__ 环境执行，
 *      跑它自己那套轮询代码；只有 fetch 被改写成绝对地址。
 *
 * 断言：调用 set_expression / play_motion 之后，客户端是否按序收到指令。
 */
import http from 'node:http'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import React from 'react'
import jsxRuntime from 'react/jsx-runtime'

const PKG = process.env.PKG ?? new URL('..', import.meta.url)

// ---------- 1. Host 插件 ----------
const routes = []
const tools = new Map()
const hostCtx = {
  logger: { info: () => {}, warn: (...a) => console.log('[host warn]', ...a) },
  webServer: { register: (route) => { routes.push(route); return () => {} } },
  tools: { register: (tool) => { tools.set(tool.name, tool); return () => {} } },
}

const host = await import(pathToFileURL(new URL('lib/index.js', PKG).pathname).href)
host.apply(hostCtx, { modelPath: 'assets/models/nuomi.vrm', modelUrl: '/dsh-avatar/model.vrm' })

// 工具注册是异步的（要读模型 + 扫目录）
for (let i = 0; i < 100 && (!tools.has('set_expression') || !tools.has('play_motion')); i++) {
  await new Promise(r => setTimeout(r, 50))
}
if (!tools.has('set_expression') || !tools.has('play_motion')) {
  console.error('FAIL: 工具未注册', [...tools.keys()])
  process.exit(1)
}
console.log('OK  Host 注册工具:', [...tools.keys()].join(', '))
console.log('OK  Host 注册路由:', routes.map(r => `${r.kind}:${r.path}`).join(', '))

// ---------- 2. HTTP 服务（按 Host 注册的路由分发） ----------
const server = http.createServer(async (req, res) => {
  const pathname = (req.url ?? '/').split('?')[0]
  const route = routes.find(r => (r.kind === 'exact' ? r.path === pathname : pathname.startsWith(r.path)))
  if (!route) { res.writeHead(404); res.end('no route'); return }
  try { await route.handler(req, res) } catch (err) { res.writeHead(500); res.end(String(err)) }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`
console.log('OK  测试服务器:', origin)

// ---------- 3. 浏览器 bundle + 最小环境 ----------
const clientSource = await readFile(new URL('lib/client.js', PKG), 'utf8')
let clientModule = null
const win = {
  __ModuleLoader__: {
    load: ({ factory }) => { clientModule = factory((id) => (id === 'react' ? React : jsxRuntime)) },
  },
  __dshAvatarLog: [],
}
globalThis.window = win
// 浏览器里 fetch 用相对地址；Node 需要绝对地址，只做这一处改写。
const nativeFetch = globalThis.fetch
globalThis.fetch = (input, init) => nativeFetch(typeof input === 'string' && input.startsWith('/') ? origin + input : input, init)

// eslint-disable-next-line no-new-func
new Function('window', 'React', 'jsxRuntime', clientSource)(win, React, jsxRuntime)
if (!clientModule?.apply) { console.error('FAIL: client bundle 没有 apply'); process.exit(1) }

const clientCtx = {
  effect: (cb) => { const dispose = cb(); return () => dispose?.() },
  slots: { inject: () => () => {}, register: () => () => {} },
}
clientModule.apply(clientCtx)
console.log('OK  client apply 已执行，轮询已启动')

const sleep = ms => new Promise(r => setTimeout(r, ms))
const poseLog = () => win.__dshAvatarLog.filter(l => l.startsWith('pose ') || l.startsWith('baseline'))

// 等第一轮轮询建立水位线
await sleep(1200)
console.log('水位线阶段 __dshAvatarLog:', poseLog())
if (!win.__dshAvatarLog.some(l => l.startsWith('baseline '))) {
  console.error('FAIL: 客户端没有建立水位线（服务端仍在用 null 表示无新指令？）')
  process.exit(1)
}
const baseline = poseLog()
if (baseline.some(l => l.startsWith('pose '))) {
  console.error('FAIL: 建立水位线阶段不应播放任何指令')
  process.exit(1)
}
console.log('OK  空队列时也能建立水位线，且不重放历史')

// 第 1 次工具调用：最容易被旧实现吞掉的那一次
await tools.get('set_expression').execute({ expression: 'joy' })
await sleep(1200)
const after1 = poseLog().slice(baseline.length)
console.log('第1次调用后新增日志:', after1)
if (!after1.some(l => l.includes('expression=joy'))) {
  console.error('FAIL: 第一条指令被吞掉了（旧实现的经典症状）')
  process.exit(1)
}
console.log('OK  第 1 条指令就生效（旧实现会吞掉第一条）')

// 第 2 次调用：只应出现 motion，不应把 expression 再发一遍
const mark = poseLog().length
await tools.get('play_motion').execute({ motion: 'bow' })
await sleep(1200)
const after2 = poseLog().slice(mark)
console.log('第2次调用后新增日志:', after2)
if (!after2.some(l => l.includes('motion=bow'))) { console.error('FAIL: 动作指令未送达'); process.exit(1) }
if (after2.some(l => l.includes('expression='))) {
  console.error('FAIL: 旧通道被重放（快照式实现会把上次的 expression 再发一遍）')
  process.exit(1)
}
console.log('OK  只播放本次指令，不重放另一通道')

// 第 3 次：表情与动作交替，顺序保持
const mark3 = poseLog().length
await tools.get('set_expression').execute({ expression: 'angry' })
await sleep(1200)
const after3 = poseLog().slice(mark3)
console.log('第3次调用后新增日志:', after3)
if (!after3.some(l => l.includes('expression=angry'))) { console.error('FAIL: 第 3 条指令未送达'); process.exit(1) }
console.log('OK  连续调用全部送达，顺序正确')

server.close()
console.log('\nALL PASS：工具调用 → PoseHub → /dsh-avatar/pose → 客户端 emit 全链路打通')
process.exit(0)
