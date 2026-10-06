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
import { mkdtemp, readFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import React from 'react'
import jsxRuntime from 'react/jsx-runtime'
import * as THREE from 'three'

const PKG = process.env.PKG ?? new URL('..', import.meta.url)

// 用户导入目录指向临时目录，避免污染真实 dsh 数据。
process.env.DSH_AVATAR_DATA_DIR = await mkdtemp(path.join(tmpdir(), 'dsh-avatar-verify-'))

// ---------- 1. Host 插件 ----------
const routes = []
const tools = new Map()
const hostCtx = {
  logger: { info: () => {}, warn: (...a) => console.log('[host warn]', ...a) },
  webServer: { register: (route) => { routes.push(route); return () => {} } },
  tools: { register: (tool) => { tools.set(tool.name, tool); return () => {} } },
  effect: (cb) => { const dispose = cb(); return () => dispose?.() },
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

// ---------- 1.5 资产导入与工具参数热更新 ----------
const enumOf = (toolName, param) => tools.get(toolName)?.parameters?.properties?.[param]?.enum ?? []
const initialMotions = enumOf('play_motion', 'motion')
console.log('初始 play_motion enum:', initialMotions.join(', '))
const builtinMotions = ['Body Block', 'Praying', 'bow', 'elbow_punch', 'idle', 'sitting_laughing']
for (const m of builtinMotions) {
  if (!initialMotions.includes(m)) { console.error(`FAIL: 内置动作 ${m} 不在 play_motion enum`); process.exit(1) }
}
console.log('OK  内置动作全部进入 play_motion enum')

// 上传 VRMA（伪造最小 GLB：只有 magic 头，AssetRegistry 只校验容器魔数）
const fakeVrma = Buffer.concat([Buffer.from('glTF'), Buffer.alloc(64)])
const upMotionRes = await fetch(`${origin}/dsh-avatar/upload?kind=motion&name=test_motion.vrma`, {
  method: 'POST', body: fakeVrma,
})
const upMotion = await upMotionRes.json()
if (!upMotion.ok || upMotion.name !== 'test_motion') { console.error('FAIL: VRMA 上传失败', upMotion); process.exit(1) }
if (!enumOf('play_motion', 'motion').includes('test_motion')) {
  console.error('FAIL: VRMA 导入后 play_motion enum 未更新')
  process.exit(1)
}
console.log('OK  VRMA 导入后 play_motion enum 热更新:', enumOf('play_motion', 'motion').join(', '))

// 上传真实 VRM（nuomi 副本改名为 custom）→ 自动成为当前模型，set_expression 用新模型 enum 重注册
const vrmData = await readFile(new URL('assets/models/nuomi.vrm', PKG))
const upModelRes = await fetch(`${origin}/dsh-avatar/upload?kind=model&name=custom.vrm`, {
  method: 'POST', body: vrmData,
})
const upModel = await upModelRes.json()
if (!upModel.ok || upModel.info.currentModel !== 'custom') {
  console.error('FAIL: VRM 上传未成为当前模型', upModel)
  process.exit(1)
}
const exprCount = enumOf('set_expression', 'expression').length
if (exprCount === 0) { console.error('FAIL: 模型导入后 set_expression 未注册'); process.exit(1) }
console.log(`OK  VRM 导入后 currentModel=custom，set_expression 重注册（${exprCount} 个表情）`)

// 删除当前模型 → 回退内置默认
const delCurrentRes = await fetch(`${origin}/dsh-avatar/delete?kind=model&name=custom`, { method: 'POST' })
const delCurrent = await delCurrentRes.json()
if (!delCurrent.ok || delCurrent.info.currentModel !== 'nuomi') {
  console.error('FAIL: 删除当前模型未回退内置默认', delCurrent)
  process.exit(1)
}
if (enumOf('set_expression', 'expression').length === 0) {
  console.error('FAIL: 回退后 set_expression 未恢复')
  process.exit(1)
}
console.log('OK  删除当前模型后回退内置 nuomi，set_expression 恢复')

// 再上传 custom → 切换回 nuomi（验证 select-model）
const upModel2 = await (await fetch(`${origin}/dsh-avatar/upload?kind=model&name=custom.vrm`, {
  method: 'POST', body: vrmData,
})).json()
if (!upModel2.ok) { console.error('FAIL: 第二次 VRM 上传失败', upModel2); process.exit(1) }
const selRes = await fetch(`${origin}/dsh-avatar/select-model`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'nuomi' }),
})
const sel = await selRes.json()
if (!sel.ok || sel.info.currentModel !== 'nuomi') {
  console.error('FAIL: select-model 切换失败', sel)
  process.exit(1)
}
console.log('OK  select-model 切换回 nuomi 成功')

// 删除非当前模型 → 当前模型不变
const delModelRes = await fetch(`${origin}/dsh-avatar/delete?kind=model&name=custom`, { method: 'POST' })
const delModel = await delModelRes.json()
if (!delModel.ok || delModel.info.currentModel !== 'nuomi') {
  console.error('FAIL: 删除非当前模型异常', delModel)
  process.exit(1)
}
// 删除导入动作 → enum 移除
const delMotionRes = await fetch(`${origin}/dsh-avatar/delete?kind=motion&name=test_motion`, { method: 'POST' })
const delMotion = await delMotionRes.json()
if (!delMotion.ok || enumOf('play_motion', 'motion').includes('test_motion')) {
  console.error('FAIL: 删除动作后 enum 未移除')
  process.exit(1)
}
console.log('OK  删除导入模型/动作后清单恢复内置')

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

// 捕获 client apply 期间的 console.error：任何一段注册失败都会在这里现形
// （历史 bug：ctx.sidebarRightTabs 直读抛错 → 整个 apply 中断 → 工具调用毫无反应）。
const applyErrors = []
const nativeConsoleError = console.error
console.error = (...args) => { applyErrors.push(args.map(String).join(' ')); nativeConsoleError(...args) }

/**
 * 造一个「像真的 Cordis context」的最小替身。两条语义必须复刻，否则这个 bug 在验证里看不出来：
 *   1. 未在「当前 ctx 的 inject 名单」里的服务名，读取时抛
 *      `cannot get property "x" without inject` —— 可选链挡不住 throw；
 *   2. `ctx.inject(deps, cb)` 的回调拿到的是**子 fiber 的 ctx**，只有它直读得到已解析的依赖
 *      （父 ctx 直读仍然抛错）；依赖不可用时回调根本不执行。
 */
function proxyCtx(target) {
  return new Proxy(target, {
    get: (t, prop) => {
      if (prop in t) return t[prop]
      throw new Error(`cannot get property "${String(prop)}" without inject`)
    },
  })
}

function makeClientCtx({ sidebarRightTabs }) {
  const slotCalls = []
  const tabCalls = []
  const services = {
    effect: (cb) => { const dispose = cb(); return () => dispose?.() },
    slots: {
      inject: () => () => {},
      register: (options, component) => { slotCalls.push({ options, component }); return () => {} },
    },
  }
  // 子 fiber：ctx.inject 回调里的 ctx
  const childTarget = { ...services }
  if (sidebarRightTabs) {
    childTarget.sidebarRightTabs = {
      register: (definition) => { tabCalls.push(definition); return () => {} },
    }
  }
  const childCtx = proxyCtx(childTarget)
  const ctx = proxyCtx({
    ...services,
    inject: (deps, callback) => {
      if (deps.includes('sidebarRightTabs') && sidebarRightTabs) callback(childCtx)
      return {}
    },
  })
  ctx.__slotCalls = slotCalls
  ctx.__tabCalls = tabCalls
  return ctx
}

// ---------- 3.1 宿主没有 sidebarRightTabs 时：必须静默降级，且指令链路照常工作 ----------
const clientCtx = makeClientCtx({ sidebarRightTabs: false })
clientModule.apply(clientCtx)
if (clientCtx.__tabCalls.length !== 0 || clientCtx.__slotCalls.length !== 0) {
  console.error('FAIL: 宿主没有 sidebarRightTabs 时不应注册任何 tab 条目')
  process.exit(1)
}
console.log('OK  client apply 已执行，无 tab 服务的宿主静默降级，轮询已启动')

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

// ---------- 4. 管理页 tab：服务可用时必须完成两阶段注册（放最后，避免多开一个轮询互相干扰） ----------
const tabCtx = makeClientCtx({ sidebarRightTabs: true })
clientModule.apply(tabCtx)
const typeCall = tabCtx.__tabCalls.find(c => c.id === 'dsh-avatar-assets')
const bodyCall = tabCtx.__slotCalls.find(c => c.options?.name === 'sidebar.right.pane.tab')
if (!typeCall || !bodyCall) {
  console.error('FAIL: 管理页 tab 未注册（type/body 任一缺失）', {
    tabCalls: tabCtx.__tabCalls, slotCalls: tabCtx.__slotCalls.map(c => c.options),
  })
  process.exit(1)
}
if (typeCall.kind !== 'dsh-avatar-assets' || bodyCall.options.key !== typeCall.id) {
  console.error('FAIL: tab 的 kind / slot key 与注册 id 不一致', { typeCall, body: bodyCall.options })
  process.exit(1)
}
console.log('OK  右栏 tab 两阶段注册：type id=kind=dsh-avatar-assets + body slot key 对齐')

// ---------- 4.5 动作清单形状契约：/dsh-avatar/info 发对象，客户端必须按 name 取 ----------
// 历史 bug：Host 改成 `{name, builtin}` 后浮层仍按裸字符串 encodeURIComponent(entry)，
// 每个动作 URL 都变成 %5Bobject%20Object%5D.vrma → 全 404 → 没有 idle → 数字人僵在 bind pose。
const infoRes = await fetch(`${origin}/dsh-avatar/info`)
const info = await infoRes.json()
if (!Array.isArray(info.animations) || typeof info.animations[0] !== 'object') {
  console.error('FAIL: info.animations 的形状变了（本断言固化 Host 契约，客户端归一化依赖它）', info.animations)
  process.exit(1)
}
const motionNames = clientModule.assetNames(info.animations)
for (const m of builtinMotions) {
  if (!motionNames.includes(m)) { console.error(`FAIL: assetNames 丢了动作 ${m}`, motionNames); process.exit(1) }
}
console.log('OK  assetNames 把 {name, builtin} 归一为动作名:', motionNames.join(', '))

const idleUrl = clientModule.motionUrl('/dsh-avatar/animations', { name: 'idle', builtin: true })
const spaceUrl = clientModule.motionUrl('/dsh-avatar/animations', { name: 'Body Block', builtin: true })
const idleStandEntry = info.animations.find(a => a.name === 'idle_stand')
if (!idleStandEntry) { console.error('FAIL: info.animations 里没有 idle_stand（待机素材没被 Host 扫到）', motionNames); process.exit(1) }
const idleStandUrl = clientModule.motionUrl('/dsh-avatar/animations', idleStandEntry)
const oldBugUrl = `/dsh-avatar/animations/${encodeURIComponent({ name: 'idle' })}.vrma`
if (idleUrl !== '/dsh-avatar/animations/idle.vrma') { console.error('FAIL: idle URL 拼错', idleUrl); process.exit(1) }
if (spaceUrl !== '/dsh-avatar/animations/Body%20Block.vrma') { console.error('FAIL: 含空格动作名未 encode', spaceUrl); process.exit(1) }
for (const [label, url] of [['idle', idleUrl], ['Body Block', spaceUrl], ['idle_stand', idleStandUrl]]) {
  const res = await fetch(origin + url)
  if (!res.ok) { console.error(`FAIL: ${label} 动作 URL 取不到（${res.status}）`, url); process.exit(1) }
}
const bugRes = await fetch(origin + oldBugUrl)
if (bugRes.ok) { console.error('FAIL: 旧写法（对象直接 encode）本应 404，契约断言失效'); process.exit(1) }
console.log(`OK  动作 URL 真实可取（200），旧写法 ${oldBugUrl} 已复现 404`)

// ---------- 4.6 待机动作的幅度契约：放大后偏差必须变大、程序化通道必须真的动、首尾必须相等 ----------
const DEG = Math.PI / 180
const angleBetween = (a, b) => {
  const dot = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3])
  return 2 * Math.acos(Math.min(1, dot)) / DEG
}
// 假 VRM：只用 normalized 骨骼节点（name 必须是 Normalized_<bone>，与 createVRMAnimationClip 一致）
const rigBones = ['hips', 'spine', 'chest', 'upperChest', 'neck', 'head',
  'leftShoulder', 'rightShoulder', 'leftUpperArm', 'rightUpperArm', 'leftLowerArm', 'rightLowerArm']
const rigNodes = new Map(rigBones.map((b) => {
  const node = new THREE.Object3D()
  node.name = `Normalized_${b[0].toUpperCase()}${b.slice(1)}`
  return [b, node]
}))
const fakeVrm = { humanoid: { getNormalizedBoneNode: (name) => rigNodes.get(name) ?? null } }

// 合成一段「素材待机」：小臂扫 10°、胯部有旋转有平移（平移是「飘」的来源）
const authoredTimes = new Float32Array([0, 0.5, 1])
const armRef = new THREE.Quaternion()
const armMid = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), 10 * DEG)
const armName = rigNodes.get('leftLowerArm').name
const hipsName = rigNodes.get('hips').name
const authored = new THREE.AnimationClip('idle', 1, [
  new THREE.QuaternionKeyframeTrack(`${armName}.quaternion`, authoredTimes,
    new Float32Array([...armRef.toArray(), ...armMid.toArray(), ...armRef.toArray()])),
  new THREE.QuaternionKeyframeTrack(`${hipsName}.quaternion`, authoredTimes,
    new Float32Array([...armRef.toArray(), ...armMid.toArray(), ...armRef.toArray()])),
  new THREE.VectorKeyframeTrack(`${hipsName}.position`, authoredTimes,
    new Float32Array([0, 1, 0, 0.004, 1, 0, 0, 1, 0])),
])

const amplified = clientModule.amplifyClip(authored, 3)
const amplifiedArm = amplified.tracks.find(t => t.name === `${armName}.quaternion`)
const armAngle = (track) => angleBetween(
  Array.from(track.values.slice(0, 4)),
  Array.from(track.values.slice(4, 8)),
)
const before = armAngle(authored.tracks.find(t => t.name === `${armName}.quaternion`))
const after = armAngle(amplifiedArm)
if (Math.abs(after - before * 3) > 0.5) {
  console.error(`FAIL: 放大倍数不对：${before.toFixed(2)}° → ${after.toFixed(2)}°（期望 ${(before * 3).toFixed(2)}°）`)
  process.exit(1)
}
const amplifiedHips = amplified.tracks.find(t => t.name === `${rigNodes.get('hips').name}.position`)
if (Math.abs(amplifiedHips.values[3] - 0.012) > 1e-6) { console.error('FAIL: 位移通道放大不对', amplifiedHips.values[3]); process.exit(1) }
console.log(`OK  amplifyClip 只放大偏差：小臂 ${before.toFixed(1)}° → ${after.toFixed(1)}°（×3），基准姿势不变`)

const idleClip = clientModule.buildIdleClip(fakeVrm, authored)
const names = idleClip.tracks.map(t => t.name)
if (new Set(names).size !== names.length) { console.error('FAIL: idle clip 有重复轨道（同一属性被驱动两次）', names); process.exit(1) }
// 默认就是「直接用素材」：不加程序化轨道、不放大，但必须锁掉胯部位移（防飘）
if (names.includes(`${rigNodes.get('head').name}.quaternion`)) {
  console.error('FAIL: 默认不应叠加程序化头部轨道（用户要的是「直接使用动作」）', names); process.exit(1)
}
if (names.includes(`${rigNodes.get('hips').name}.position`)) {
  console.error('FAIL: 胯部位移没锁住 —— 整个人会平移/上下飘', names); process.exit(1)
}
if (!names.includes(`${armName}.quaternion`) || !names.includes(`${rigNodes.get('hips').name}.quaternion`)) {
  console.error('FAIL: 素材自身的旋转轨道被误删', names); process.exit(1)
}
if (angleBetween(Array.from(idleClip.tracks.find(t => t.name === `${armName}.quaternion`).values.slice(0, 4)),
  Array.from(idleClip.tracks.find(t => t.name === `${armName}.quaternion`).values.slice(4, 8))) !== before) {
  console.error('FAIL: 默认 gain=1 不应改动素材幅度')
  process.exit(1)
}
console.log(`OK  buildIdleClip 默认原样使用素材（gain=1）：${idleClip.tracks.length} 条轨道，胯部位移已锁，旋转保留`)

const unlocked = clientModule.buildIdleClip(fakeVrm, authored, { lockHipsTranslation: false })
if (!unlocked.tracks.some(t => t.name === `${rigNodes.get('hips').name}.position`)) {
  console.error('FAIL: lockHipsTranslation:false 时应当保留胯部位移轨道')
  process.exit(1)
}
const withProcedural = clientModule.buildIdleClip(fakeVrm, authored, { procedural: true })
const headTrack = withProcedural.tracks.find(t => t.name === `${rigNodes.get('head').name}.quaternion`)
if (!headTrack) { console.error('FAIL: procedural:true 时应叠加程序化头部通道'); process.exit(1) }
let headMax = 0
for (let i = 4; i < headTrack.values.length; i += 4) headMax = Math.max(headMax, angleBetween(Array.from(headTrack.values.slice(0, 4)), Array.from(headTrack.values.slice(i, i + 4))))
if (headMax < 2) { console.error(`FAIL: 程序化头部幅度过小（${headMax.toFixed(2)}°）`); process.exit(1) }
console.log(`OK  procedural:true 时额外叠加程序化上半身（头部最大 ${headMax.toFixed(1)}°），默认关闭`)

const fallback = clientModule.buildIdleClip(fakeVrm, null, { amp: 1 })
const fallbackNames = fallback.tracks.map(t => t.name)
if (fallbackNames.some(n => n.startsWith(`${rigNodes.get('hips').name}.`))) {
  console.error('FAIL: 程序化兜底不许碰胯部（会飘）', fallbackNames); process.exit(1)
}
const fallbackArm = fallback.tracks.find(t => t.name === `${rigNodes.get('leftUpperArm').name}.quaternion`)
if (!fallbackArm) { console.error('FAIL: 无素材时没有程序化手臂兜底'); process.exit(1) }
const armDown = angleBetween(Array.from(fallbackArm.values.slice(0, 4)), [0, 0, 0, 1])
if (armDown < 30) { console.error(`FAIL: 无素材时手臂没有垂下（仅 ${armDown.toFixed(1)}°）`); process.exit(1) }
for (const track of fallback.tracks) {
  const stride = track.ValueTypeName === 'quaternion' ? 4 : 3
  const first = Array.from(track.values.slice(0, stride))
  const last = Array.from(track.values.slice(track.values.length - stride))
  if (Math.max(...first.map((v, i) => Math.abs(v - last[i]))) > 1e-6) {
    console.error(`FAIL: 兜底轨道首尾不相等，循环会跳帧：${track.name}`); process.exit(1)
  }
}
console.log(`OK  无素材时的程序化兜底：不碰胯部、手臂垂下 ${armDown.toFixed(1)}°、首尾相等`)

// ---------- 4.7 真实待机素材本身必须「站得住、接得上」 ----------
function readVrma(file) {
  const buf = readFileSync(file)
  let off = 12, json = null, bin = null
  while (off < buf.length) {
    const len = buf.readUInt32LE(off), type = buf.toString('latin1', off + 4, off + 8)
    if (type === 'JSON') json = JSON.parse(buf.toString('utf8', off + 8, off + 8 + len))
    if (type.startsWith('BIN')) bin = buf.subarray(off + 8, off + 8 + len)
    off += 8 + len
  }
  const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength)
  const counts = { SCALAR: 1, VEC3: 3, VEC4: 4 }
  const accessor = (i) => {
    const a = json.accessors[i], bv = json.bufferViews[a.bufferView]
    const n = counts[a.type], size = a.componentType === 5126 ? 4 : 2
    const start = (bv.byteOffset ?? 0) + (a.byteOffset ?? 0)
    const get = o => a.componentType === 5126 ? dv.getFloat32(o, true) : dv.getUint16(o, true)
    const rows = []
    for (let k = 0; k < a.count; k++) {
      const row = []
      for (let c = 0; c < n; c++) row.push(get(start + (k * n + c) * size))
      rows.push(n === 1 ? row[0] : row)
    }
    return rows
  }
  return { json, accessor }
}

const idleAsset = new URL('assets/animations/idle_stand.vrma', PKG)
const { json: idleJson, accessor } = readVrma(idleAsset)
const vrmaExt = idleJson.extensions?.VRMC_vrm_animation
if (!vrmaExt) { console.error('FAIL: idle_stand.vrma 不是 VRMA（缺 VRMC_vrm_animation）'); process.exit(1) }
const boneCount = Object.keys(vrmaExt.humanoid.humanBones).length
if (boneCount < 20) { console.error(`FAIL: idle_stand.vrma 骨骼太少（${boneCount}），大概是姿势片段而不是完整待机`); process.exit(1) }
const boneOf = {}
for (const [name, v] of Object.entries(vrmaExt.humanoid.humanBones)) boneOf[v.node] = name
const anim = idleJson.animations[0]
let seamMax = 0, hipsYRange = 0, hipsXZRange = 0, duration = 0
for (const ch of anim.channels) {
  const sampler = anim.samplers[ch.sampler]
  const times = accessor(sampler.input)
  duration = Math.max(duration, times[times.length - 1])
  const vals = accessor(sampler.output)
  const a0 = vals[0], a1 = vals[vals.length - 1]
  if (ch.target.path === 'rotation') {
    const dot = Math.min(1, Math.abs(a0[0] * a1[0] + a0[1] * a1[1] + a0[2] * a1[2] + a0[3] * a1[3]))
    seamMax = Math.max(seamMax, 2 * Math.acos(dot) / DEG)
  }
  if (boneOf[ch.target.node] === 'hips' && ch.target.path === 'translation') {
    const ys = vals.map(v => v[1])
    const xs = vals.map(v => v[0]), zs = vals.map(v => v[2])
    hipsYRange = Math.max(...ys) - Math.min(...ys)
    hipsXZRange = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs))
  }
}
if (seamMax > 1.5) { console.error(`FAIL: idle_stand.vrma 循环接缝 ${seamMax.toFixed(1)}° 太大，循环时会跳一下`); process.exit(1) }
if (hipsYRange > 0.02) { console.error(`FAIL: idle_stand.vrma 胯部上下起伏 ${(hipsYRange * 100).toFixed(1)}cm 太大（会飘）`); process.exit(1) }
if (hipsXZRange > 0.05) { console.error(`FAIL: idle_stand.vrma 胯部水平位移 ${(hipsXZRange * 100).toFixed(1)}cm 太大（会滑）`); process.exit(1) }
console.log(`OK  idle_stand.vrma：${boneCount} 骨骼 / ${duration.toFixed(1)}s，循环接缝 ${seamMax.toFixed(2)}°，胯部起伏 ${(hipsYRange * 100).toFixed(1)}cm、水平 ${(hipsXZRange * 100).toFixed(1)}cm（站得住）`)

// 素材自带的五官通道必须能在模型上绑上（否则表情「静默失效」）：
// VRMA 用 VRM1 的 preset 名（blinkLeft/oh/sad…），模型是 VRM0（blink_l/o/sorrow…）。
const VRM1_TO_VRM0 = {
  aa: 'a', ih: 'i', ou: 'u', ee: 'e', oh: 'o',
  blink: 'blink', blinkLeft: 'blink_l', blinkRight: 'blink_r',
  happy: 'joy', angry: 'angry', sad: 'sorrow', relaxed: 'fun',
  lookUp: 'lookup', lookDown: 'lookdown', lookLeft: 'lookleft', lookRight: 'lookright',
  neutral: 'neutral',
}
const facePresets = Object.keys(vrmaExt.expressions?.preset ?? {})
if (facePresets.length === 0) {
  console.error('FAIL: idle_stand.vrma 没有表情通道（待机的眨眼就没了）')
  process.exit(1)
}
if (!facePresets.includes('blink')) {
  console.error('FAIL: idle_stand.vrma 没有 blink 通道（待机不眨眼会显得很假）', facePresets)
  process.exit(1)
}
// 解析模型的 blend shape（nuomi.vrm 是 GLB）
const modelBuf = readFileSync(new URL('assets/models/nuomi.vrm', PKG))
let modelJson = null
if (modelBuf.toString('latin1', 0, 4) === 'glTF') {
  const len = modelBuf.readUInt32LE(12)
  modelJson = JSON.parse(modelBuf.toString('utf8', 20, 20 + len))
} else {
  modelJson = JSON.parse(modelBuf.toString('utf8'))
}
const modelPresets = (modelJson.extensions?.VRM?.blendShapeMaster?.blendShapeGroups ?? [])
  .map(g => g.presetName ?? g.name)
const missingFaces = facePresets.filter(p => !modelPresets.includes(VRM1_TO_VRM0[p] ?? p))
if (missingFaces.length > 0) {
  console.error(`FAIL: idle_stand 的表情通道在模型上没有对应 blend shape：${missingFaces.join(', ')}（模型有：${modelPresets.join(', ')}）`)
  process.exit(1)
}
console.log(`OK  idle_stand 的表情通道 ${facePresets.join(', ')} 在模型上都有对应 blend shape；lookAt 轨道=${vrmaExt.lookAt ? '有' : '无'}`)

// 动作加载计划：待机素材单独先加载，其余动作并行后台拉（不能让 Body Block 的 2.6MB 挡着待机）
const plan = clientModule.planMotionLoad(info.animations, 'idle_stand')
if (plan.idle?.name !== 'idle_stand') { console.error('FAIL: 待机素材没被单独挑出来', plan.idle); process.exit(1) }
if (plan.rest.some(a => a.name === 'idle_stand')) { console.error('FAIL: 待机素材同时出现在后台列表里，会被下两次'); process.exit(1) }
if (plan.rest.length !== info.animations.length - 1) { console.error('FAIL: 后台列表条数不对', plan.rest.length); process.exit(1) }
if (plan.rest[0]?.name !== info.animations[0].name) { console.error('FAIL: 后台列表顺序被打乱'); process.exit(1) }
const noIdlePlan = clientModule.planMotionLoad(info.animations, null)
if (noIdlePlan.idle !== null || noIdlePlan.rest.length !== info.animations.length) {
  console.error('FAIL: 没有待机素材时应当全部走后台列表')
  process.exit(1)
}
console.log(`OK  动作加载计划：先加载 idle_stand（${idleStandEntry ? '阻塞' : ''}），其余 ${plan.rest.length} 个（含 Body Block 2.6MB）并行后台拉`)

if (clientModule.pickIdleMotion(['bow', 'idle', 'idle_stand']) !== 'idle_stand') {
  console.error('FAIL: 有 idle_stand 时应优先用它做待机'); process.exit(1)
}
if (clientModule.pickIdleMotion(['bow', 'idle']) !== 'idle' || clientModule.pickIdleMotion(['bow']) !== null) {
  console.error('FAIL: 待机素材优先级回退不对'); process.exit(1)
}
console.log('OK  待机优先级 idle_stand → idle → 程序化兜底')

// ---------- 4.8 浮层拖拽：人物本体必须能贴到窗口边，且不能被拖出窗口 ----------
const clamp = clientModule.clampToViewport
const W = 220, H = 300, VW = 1440, VH = 900
const expect = (label, got, left, top) => {
  if (got.left !== left || got.top !== top) {
    console.error(`FAIL: ${label} → ${JSON.stringify(got)}，期望 {left:${left},top:${top}}`)
    process.exit(1)
  }
}
// 无透明边距时（padding=0）：整个方框留在视口内
expect('拖出左上角', clamp(-500, -500, VW, VH, W, H), 0, 0)
expect('拖出右下角', clamp(9999, 9999, VW, VH, W, H), VW - W, VH - H)
expect('视口内原样保留', clamp(100, 200, VW, VH, W, H), 100, 200)
expect('窄窗口（比浮层还小）贴左上', clamp(-50, -50, 180, 200, W, H), 0, 0)

// 有透明边距时：允许空画布溢出，但「人物本体」要能贴到窗口边、且不得越出
// 实测 nuomi.vrm 待机姿势：画布 220×300 里人约 74px 宽，左右各留 ~73px。
const pad = { left: 73, right: 73, top: 16, bottom: 16 }
const contentLeft = p => p.left + pad.left
const contentRight = p => p.left + W - pad.right
const contentTop = p => p.top + pad.top
const contentBottom = p => p.top + H - pad.bottom
const rightMost = clamp(9999, 9999, VW, VH, W, H, pad)
if (contentRight(rightMost) !== VW || contentBottom(rightMost) !== VH) {
  console.error(`FAIL: 拖到右下极限时人物没贴到窗口边：人右缘=${contentRight(rightMost)}（视口 ${VW}）、人下缘=${contentBottom(rightMost)}（视口 ${VH}）`)
  process.exit(1)
}
const leftMost = clamp(-9999, -9999, VW, VH, W, H, pad)
if (contentLeft(leftMost) !== 0 || contentTop(leftMost) !== 0) {
  console.error(`FAIL: 拖到左上极限时人物没贴到窗口边：人左缘=${contentLeft(leftMost)}、人上缘=${contentTop(leftMost)}`)
  process.exit(1)
}
// 任何输入下，人物本体（方框去掉透明边距后的矩形）必须完整留在视口内
for (const [l, t] of [[-9999, -9999], [9999, 9999], [-W, VH], [VW, -H], [VW / 2, VH / 2], [0, 0]]) {
  const p = clamp(l, t, VW, VH, W, H, pad)
  if (contentLeft(p) < 0 || contentTop(p) < 0 || contentRight(p) > VW || contentBottom(p) > VH) {
    console.error(`FAIL: 夹取后人物本体越界 left=${p.left} top=${p.top} → 人 [${contentLeft(p)},${contentRight(p)}]×[${contentTop(p)},${contentBottom(p)}]，视口 ${VW}×${VH}`)
    process.exit(1)
  }
}
// 窄窗口下也不能把人物挤出视口
const narrow = clamp(9999, 9999, 180, 200, W, H, pad)
if (contentLeft(narrow) < 0 || contentRight(narrow) > 180) {
  console.error(`FAIL: 窄窗口夹取后人物越界：人 [${contentLeft(narrow)},${contentRight(narrow)}]`)
  process.exit(1)
}
console.log(`OK  拖拽夹取：人物本体可贴到四边（左极限 left=${leftMost.left}、右极限 left=${rightMost.left}），空画布溢出但人不出窗口`)

// ---------- 5. apply 全程不允许出现任何 console.error（注册失败即回归） ----------
console.error = nativeConsoleError
if (applyErrors.length > 0) {
  console.error('FAIL: client apply 期间出现错误：', applyErrors)
  process.exit(1)
}
console.log('OK  client apply 全程无错误（三段注册各自兜底）')

server.close()
console.log('\nALL PASS：工具调用 → PoseHub → /dsh-avatar/pose → 客户端 emit 全链路打通')
process.exit(0)
