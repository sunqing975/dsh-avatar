import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm'
import type { VRM } from '@pixiv/three-vrm'
import { VRMAnimationLoaderPlugin, createVRMAnimationClip, type VRMAnimation } from '@pixiv/three-vrm-animation'
import { assetName, assetNames, motionUrl, planMotionLoad, type AssetEntry } from './assets.ts'
import { buildIdleClip, idleOptionsFromWindow, pickIdleMotion, trackNodeName } from './idle-motion.ts'
import { NO_PADDING, type FloatingPadding } from './drag.ts'

/** 表情自动重置延迟（毫秒），避免表情一直僵在脸上。 */
const EXPRESSION_RESET_MS = 5000

/**
 * 取景余量：模型占满画面「限制方向」的比例约为 1/FRAME_MARGIN。
 * 1.12 → 人物约占画面 89%，四周留 5%~8% 空边。
 */
const FRAME_MARGIN = 1.12

/**
 * 数字人 VRM 渲染控制器：three.js 场景 + 表情/动作播放。
 * 参考 nuomi-avatar 壳的 vrm-model-adapter 经验实现（代码全新）。
 */
export class AvatarController {
  private renderer!: THREE.WebGLRenderer
  private scene!: THREE.Scene
  private camera!: THREE.PerspectiveCamera
  private clock = new THREE.Clock()
  private vrm: VRM | null = null
  private mixer: THREE.AnimationMixer | null = null
  private clips = new Map<string, THREE.AnimationClip>()
  private actions = new Map<string, THREE.AnimationAction>()
  private rafId = 0
  private disposed = false
  private currentExpression: string | null = null
  private resetTimer: ReturnType<typeof setTimeout> | null = null
  private resizeObserver: ResizeObserver | null = null
  /**
   * 模型/动作还没就绪时到达的指令先暂存，就绪后补播。
   * 否则「刚打开页面就让数字人做个动作」会因为 clips 还空着而被静默丢掉。
   */
  private pendingExpression: string | null = null
  private pendingMotion: string | null = null
  /** 一次性动作播完后置位，由渲染循环在下一帧切回 idle（不在事件回调里直接切）。 */
  private returnToIdle = false
  /** 待机姿势生效后要等几帧再量人物边距（mixer 在 vrm.update 之后才写姿势）。 */
  private paddingCountdown = 0
  /** 后台动作是否还在加载（期间到达的 play_motion 指令先挂起，加载完补播）。 */
  private motionsLoading = false
  private motionTotal = 0
  private motionLoaded = 0
  /** 绑定动作到骨骼的串行队列：createVRMAnimationClip 会动 vrm（lookAt proxy），不能并发。 */
  private clipQueue: Promise<void> = Promise.resolve()

  /**
   * 当前姿势下人物本体相对画布的透明边距（px）。
   * 拖拽夹取用它把「人」而不是「空画布」贴到窗口边（画布 220 宽，人只有约 74 宽）。
   */
  padding: FloatingPadding = { ...NO_PADDING }

  /** 边距量出来后回调（组件据此重算默认位置）。 */
  onPaddingChange: ((padding: FloatingPadding) => void) | null = null

  constructor(private readonly canvas: HTMLCanvasElement) {}

  async init(): Promise<void> {
    this.scene = new THREE.Scene()
    this.camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100)
    this.camera.position.set(0, 1.45, -2.1)
    this.camera.lookAt(0, 1.0, 0)

    // 灯光：环境光 + 主方向光，阴影增强立体感。
    const ambient = new THREE.AmbientLight(0xffffff, 0.65)
    this.scene.add(ambient)
    const dir = new THREE.DirectionalLight(0xffffff, 1.1)
    dir.position.set(1.2, 2.4, 1.8)
    this.scene.add(dir)
    const rim = new THREE.DirectionalLight(0x88aaff, 0.35)
    rim.position.set(-1.5, 1.0, -1.2)
    this.scene.add(rim)

    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.outputColorSpace = THREE.SRGBColorSpace

    const resize = () => {
      const { clientWidth, clientHeight } = this.canvas
      if (clientWidth === 0 || clientHeight === 0) return
      this.renderer.setSize(clientWidth, clientHeight, false)
      this.camera.aspect = clientWidth / clientHeight
      this.camera.updateProjectionMatrix()
    }
    resize()
    this.resizeObserver = new ResizeObserver(resize)
    this.resizeObserver.observe(this.canvas)

    this.loop()
  }

  async loadModel(url: string): Promise<void> {
    if (this.disposed) return
    const loader = new GLTFLoader()
    loader.register((parser) => new VRMLoaderPlugin(parser))
    loader.register((parser) => new VRMAnimationLoaderPlugin(parser))
    const gltf = await loader.loadAsync(url)
    const vrm = gltf.userData.vrm as VRM
    VRMUtils.removeUnnecessaryJoints(vrm.scene)
    this.vrm = vrm
    // 模型正面朝向修正：标准 VRM 正面向 +Z；若模型正面朝 -Z（背对相机），旋转 180°。
    vrm.scene.rotation.y = Math.PI
    vrm.scene.traverse((obj) => {
      obj.frustumCulled = false
    })
    this.mixer = new THREE.AnimationMixer(vrm.scene)
    // 一次性动作播完（LoopOnce 结束）后回到待机，否则数字人会僵在动作最后一帧。
    this.mixer.addEventListener('finished', (event) => {
      if (this.disposed) return
      // idle 本身是循环动作，不会触发 finished。
      if (this.actions.get('idle') === event.action) return
      if (!this.clips.has('idle')) return
      this.returnToIdle = true
    })
    this.scene.add(vrm.scene)
    // 按模型包围盒自动取景：竖直与水平都要拟合，四周留余量（头顶/脚不裁切）。
    const box = new THREE.Box3().setFromObject(vrm.scene)
    const center = box.getCenter(new THREE.Vector3())
    const size = box.getSize(new THREE.Vector3())
    // 画布是竖长条（220x300），横向可能比纵向先被裁，所以两个方向都要算。
    // 取景比例以画布实际尺寸为准：init() 里读 clientWidth 时可能还没布局完，camera.aspect 会是旧值。
    const aspect = this.canvas.clientWidth > 0 && this.canvas.clientHeight > 0
      ? this.canvas.clientWidth / this.canvas.clientHeight
      : this.camera.aspect
    this.camera.aspect = aspect
    const halfTan = Math.tan((this.camera.fov * Math.PI) / 180 / 2)
    const dist = Math.max(
      (size.y / 2) / halfTan, // 竖向装得下
      (size.x / 2) / (halfTan * aspect), // 横向也装得下
    ) * FRAME_MARGIN
    this.camera.position.set(center.x, center.y, center.z + dist)
    // 视线必须落在包围盒中心。早期写成 `center.y + size.y * 0.08`，等于把相机抬高看，
    // 人物整体下移约 13cm，正好吃掉下边距——脚就是这么被裁掉的（实测裁掉 12px / 4%）。
    this.camera.lookAt(center.x, center.y, center.z)
    this.camera.updateProjectionMatrix()

    // 模型加载期间到达的表情指令补播（动作要等 VRMA 就绪，见 loadAnimations 末尾）。
    if (this.pendingExpression !== null) {
      const expression = this.pendingExpression
      this.pendingExpression = null
      this.playExpression(expression)
    }
  }

  /**
   * 加载 VRMA 动作清单。必须在 loadModel 之后调用。
   *
   * 顺序很重要：**待机素材先单独加载并立刻播**，其余动作并行扔到后台。
   * 内置动作合计约 3.6MB（`Body Block.vrma` 一个就 2.6MB 且排在清单第一个），
   * 早年串行全下完才播待机，等于让人举着手在 bind pose 站好几秒。
   *
   * 入参用 `AssetEntry`（`{name, builtin}` 或裸字符串）：Host 的资产注册表发对象，
   * 这里统一归一化再拼 URL，避免把对象 encode 成 `%5Bobject%20Object%5D` 导致动作全 404。
   */
  async loadAnimations(entries: readonly AssetEntry[], baseUrl: string): Promise<void> {
    const vrm = this.vrm
    if (!vrm) return
    const idleOptions = idleOptionsFromWindow(window)
    // 已有 clip 的情况（理论上不该有，兜底）：先清掉，避免残留旧模型的绑定。
    const idleSource = pickIdleMotion(assetNames(entries), idleOptions.motion)
    const { idle: idleEntry, rest } = planMotionLoad(entries, idleSource)

    // ---------- 1) 待机：阻塞加载，先把人放下待机 ----------
    const idleStarted = now()
    if (idleEntry) await this.loadMotion(vrm, idleEntry, baseUrl)
    const idleBase = idleSource ? this.clips.get(idleSource) ?? null : null
    const idle = buildIdleClip(vrm, idleBase, idleOptions)
    this.clips.set('idle', idle)
    const unbound = idle.tracks.filter(track => !THREE.PropertyBinding.findNode(vrm.scene, trackNodeName(track)))
    // 素材自带的五官通道（idle_stand 有 blink/blinkLeft/oh/sad + lookAt）：绑不上的话表情会静默失效。
    const faceTracks = idle.tracks.filter(track => track.name.includes('.weight'))
    const faceUnbound = faceTracks.filter(track => !THREE.PropertyBinding.findNode(vrm.scene, trackNodeName(track)))
    this.logLine(`controller:idle:source=${idleSource ?? 'procedural'}:tracks=${idle.tracks.length}:unbound=${unbound.length}:gain=${idleOptions.gain}:lockHips=${idleOptions.lockHipsTranslation}:face=${faceTracks.map(t => trackNodeName(t)).join('|') || 'none'}:faceUnbound=${faceUnbound.length}:ms=${Math.round(now() - idleStarted)}`)
    if (unbound.length > 0) {
      // eslint-disable-next-line no-console
      console.warn('[dsh-avatar] idle clip 有未绑定轨道（模型缺骨骼？）:', unbound.map(t => t.name).join(', '))
    }
    if (faceUnbound.length > 0) {
      // eslint-disable-next-line no-console
      console.warn('[dsh-avatar] idle 的表情通道绑不上（模型没有对应 blend shape？）:', faceUnbound.map(t => t.name).join(', '))
    }
    // 常驻待机循环。
    this.playMotion('idle', true)
    // 等待机姿势真正写进骨骼后再量一次人物边距（拖拽夹取要用）。
    this.paddingCountdown = 2

    // ---------- 2) 其余动作：并行后台加载，不挡待机 ----------
    const restStarted = now()
    this.motionsLoading = rest.length > 0
    this.motionTotal = rest.length
    this.motionLoaded = 0
    void Promise.all(rest.map(async (entry) => {
      const name = assetName(entry)
      // 网络（最贵的一段）并行；绑定到骨骼是 CPU 且会动 vrm（lookAt proxy），排成串行队列。
      const vrmAnimation = await this.fetchVrmAnimation(entry, baseUrl)
      if (!vrmAnimation) return
      await (this.clipQueue = this.clipQueue.then(() => {
        this.clips.set(name, createVRMAnimationClip(vrmAnimation, vrm))
        this.motionLoaded += 1
      }))
    })).then(() => {
      this.motionsLoading = false
      this.logLine(`controller:motions:loaded=${this.motionLoaded}/${this.motionTotal}:ms=${Math.round(now() - restStarted)}`)
      // 后台加载期间到达的动作指令，现在补播（playMotion 会把它挂在 pendingMotion 上）。
      if (this.pendingMotion !== null) {
        const motion = this.pendingMotion
        this.pendingMotion = null
        this.playMotion(motion)
      }
    })
  }

  /** fetch + 解析一个 VRMA，返回原始 VRMAnimation（绑定到骨骼交给串行队列做）。 */
  private async fetchVrmAnimation(entry: AssetEntry, baseUrl: string): Promise<VRMAnimation | null> {
    const name = assetName(entry)
    try {
      const loader = new GLTFLoader()
      loader.register((parser) => new VRMAnimationLoaderPlugin(parser))
      const gltf = await loader.loadAsync(motionUrl(baseUrl, entry))
      const vrmAnimation = ((gltf.userData.vrmAnimations ?? []) as VRMAnimation[])[0]
      if (!vrmAnimation) {
        // eslint-disable-next-line no-console
        console.warn('[dsh-avatar] motion %s has no vrmAnimations', name)
        return null
      }
      return vrmAnimation
    } catch (err) {
      // 单个动作加载失败不影响其余动作。
      // eslint-disable-next-line no-console
      console.warn('[dsh-avatar] failed to load motion %s: %s', name, err instanceof Error ? err.message : err)
      return null
    }
  }

  /** 加载并绑定单个动作（待机素材走这条路，需要立刻可用）。 */
  private async loadMotion(vrm: VRM, entry: AssetEntry, baseUrl: string): Promise<void> {
    const vrmAnimation = await this.fetchVrmAnimation(entry, baseUrl)
    if (vrmAnimation) this.clips.set(assetName(entry), createVRMAnimationClip(vrmAnimation, vrm))
  }

  /**
   * 量出「人物本体」在画布里的透明边距：把当前姿势的蒙皮包围盒投影到画布像素。
   * 画布 220×300 而站立人物只有约 74px 宽，不量这一下，拖到窗口边时人还差 70 多像素。
   */
  private measurePadding(): void {
    const vrm = this.vrm
    if (!vrm || this.disposed) return
    const width = this.canvas.clientWidth
    const height = this.canvas.clientHeight
    if (width === 0 || height === 0) return
    // SkinnedMesh 的 boundingBox 会缓存，必须清掉才会按当前姿势重算
    //（运行时初值就是 null，只是 three 的类型标成了 Box3）。
    vrm.scene.traverse((obj) => {
      if (!(obj as THREE.SkinnedMesh).isSkinnedMesh) return
      ;(obj as unknown as { boundingBox: THREE.Box3 | null }).boundingBox = null
    })
    const box = new THREE.Box3().setFromObject(vrm.scene)
    if (box.isEmpty()) return
    const point = new THREE.Vector3()
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
    for (const x of [box.min.x, box.max.x]) {
      for (const y of [box.min.y, box.max.y]) {
        for (const z of [box.min.z, box.max.z]) {
          point.set(x, y, z).project(this.camera)
          const px = ((point.x + 1) / 2) * width
          const py = ((1 - point.y) / 2) * height
          minX = Math.min(minX, px); maxX = Math.max(maxX, px)
          minY = Math.min(minY, py); maxY = Math.max(maxY, py)
        }
      }
    }
    const padding: FloatingPadding = {
      left: Math.max(0, Math.round(minX)),
      right: Math.max(0, Math.round(width - maxX)),
      top: Math.max(0, Math.round(minY)),
      bottom: Math.max(0, Math.round(height - maxY)),
    }
    this.padding = padding
    this.logLine(`controller:padding:l=${padding.left}:r=${padding.right}:t=${padding.top}:b=${padding.bottom}`)
    this.onPaddingChange?.(padding)
  }

  /** 统一的排查日志：写 console 并进 window.__dshAvatarLog。 */
  private logLine(line: string): void {
    // eslint-disable-next-line no-console
    console.log('[dsh-avatar]', line)
    const w = window as unknown as { __dshAvatarLog?: string[] }
    w.__dshAvatarLog = w.__dshAvatarLog ?? []
    w.__dshAvatarLog.push(line)
  }

  /** 播放动作：切换前停掉其他动作。loop=true 用于 idle 待机循环。 */
  playMotion(name: string, loop = false): void {
    // eslint-disable-next-line no-console
    console.log('[dsh-avatar] playMotion:', name, 'clips:', this.clips.size, 'hasClip:', this.clips.has(name))
    const w = window as unknown as { __dshAvatarLog?: string[] }
    w.__dshAvatarLog = w.__dshAvatarLog ?? []
    w.__dshAvatarLog.push(`controller:motion:${name}:clip=${this.clips.has(name)}`)
    const mixer = this.mixer
    const clip = this.clips.get(name)
    if (!mixer || !clip) {
      // 动作还没加载到：待机是阻塞加载的，所以「clips 为空」不再是唯一判据 ——
      // 后台并行加载其余动作期间到达的指令也要挂起，加载完补播，而不是静默丢掉。
      if (!this.disposed && (this.clips.size === 0 || this.motionsLoading)) this.pendingMotion = name
      else w.__dshAvatarLog?.push(`controller:motion-missing:${name}`)
      return
    }
    this.returnToIdle = false
    // 停掉所有动作，再播目标动作。
    for (const [n, action] of this.actions) {
      if (n !== name) action.stop()
    }
    let action = this.actions.get(name)
    if (!action) {
      action = mixer.clipAction(clip)
      this.actions.set(name, action)
    }
    action.reset()
    action.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1)
    action.clampWhenFinished = !loop
    action.play()
  }

  /** 播放表情：切换前重置上一个，5 秒后自动重置回中性。 */
  playExpression(name: string): void {
    // eslint-disable-next-line no-console
    console.log('[dsh-avatar] playExpression:', name, 'vrm:', !!this.vrm, 'exprMgr:', !!this.vrm?.expressionManager)
    const w = window as unknown as { __dshAvatarLog?: string[] }
    w.__dshAvatarLog = w.__dshAvatarLog ?? []
    w.__dshAvatarLog.push(`controller:expression:${name}:vrm=${!!this.vrm}:exprMgr=${!!this.vrm?.expressionManager}`)
    const vrm = this.vrm
    if (!vrm?.expressionManager) {
      // 模型还没加载完：暂存，loadModel 末尾补播。
      if (!this.disposed) this.pendingExpression = name
      return
    }
    // 表情不存在（模型没这个 blend shape）时不改状态，避免 5 秒后去清一个不存在的表情。
    if (!vrm.expressionManager.getExpression(name)) {
      w.__dshAvatarLog?.push(`controller:expression-missing:${name}`)
      return
    }
    if (this.currentExpression !== null && this.currentExpression !== name) {
      vrm.expressionManager.setValue(this.currentExpression, 0)
    }
    vrm.expressionManager.setValue(name, 1)
    this.currentExpression = name
    if (this.resetTimer !== null) clearTimeout(this.resetTimer)
    this.resetTimer = setTimeout(() => {
      if (this.currentExpression !== null) {
        this.vrm?.expressionManager?.setValue(this.currentExpression, 0)
      }
      this.currentExpression = null
    }, EXPRESSION_RESET_MS)
  }

  /**
   * 把工具驱动的表情「压」回 1。
   *
   * 待机素材自带五官通道（`idle_stand` 有 blink / blinkLeft / oh / sad），mixer 每帧都会把
   * 这些通道的权重写成素材里的值 —— 于是 `set_expression('sorrow'|'blink'|'oh')` 会在下一帧
   * 被静默覆盖掉（通道名重叠：sorrow↔sad、o↔oh、blink_l↔blinkLeft）。
   * 这里在 mixer 写完、vrm.update 应用之前再压一次，保证「工具表情优先于待机表情」。
   */
  private reassertExpression(): void {
    const name = this.currentExpression
    if (name === null) return
    this.vrm?.expressionManager?.setValue(name, 1)
  }

  /**
   * 资产变更后重载数字人：保留 renderer/camera/灯光，只重建模型与动作。
   * 为什么不新建 AvatarController：同一个 canvas 上 dispose() 会 forceContextLoss，
   * 丢失后的 WebGL context 无法复用，新 renderer 会拿到坏 context。
   */
  async reload(modelUrl: string, animations: readonly AssetEntry[], baseUrl: string): Promise<void> {
    if (this.disposed) return
    this.resetResources()
    await this.loadModel(modelUrl)
    await this.loadAnimations(animations, baseUrl)
  }

  /** 释放模型/动作相关资源，保留渲染设施。 */
  private resetResources(): void {
    if (this.resetTimer !== null) clearTimeout(this.resetTimer)
    this.resetTimer = null
    this.pendingExpression = null
    this.pendingMotion = null
    this.returnToIdle = false
    this.currentExpression = null
    if (this.vrm) {
      this.scene?.remove(this.vrm.scene)
      VRMUtils.deepDispose(this.vrm.scene)
      this.vrm = null
    }
    this.mixer = null
    this.clips.clear()
    this.actions.clear()
    this.motionsLoading = false
    this.motionTotal = 0
    this.motionLoaded = 0
    this.clipQueue = Promise.resolve()
  }

  dispose(): void {
    this.disposed = true
    cancelAnimationFrame(this.rafId)
    if (this.resetTimer !== null) clearTimeout(this.resetTimer)
    this.pendingExpression = null
    this.pendingMotion = null
    this.returnToIdle = false
    this.resizeObserver?.disconnect()
    if (this.renderer) {
      this.renderer.dispose()
      this.renderer.forceContextLoss?.()
    }
    // 释放 VRM 资源
    if (this.vrm) {
      this.scene?.remove(this.vrm.scene)
      VRMUtils.deepDispose(this.vrm.scene)
      this.vrm = null
    }
    this.mixer = null
    this.clips.clear()
    this.actions.clear()
  }

  private loop(): void {
    if (this.disposed) return
    const delta = this.clock.getDelta()
    // 顺序：先让 mixer 写姿势/表情权重，再把工具表情压回去，最后 vrm.update 把姿势
    // 与表情真正应用到骨骼/morph（早期顺序相反，会让表情慢一帧，还会被素材表情盖掉）。
    this.mixer?.update(delta)
    this.reassertExpression()
    if (this.vrm) this.vrm.update(delta)
    // 'finished' 事件在 mixer.update 内部派发；切场景放到下一帧做，避免在派发过程中启停 action。
    if (this.returnToIdle) {
      this.returnToIdle = false
      this.playMotion('idle', true)
    }
    // 待机姿势生效后再量人物边距（姿势要等 vrm.update 写进骨骼，所以隔一帧量）。
    if (this.paddingCountdown > 0 && --this.paddingCountdown === 0) this.measurePadding()
    this.renderer.render(this.scene, this.camera)
    this.rafId = requestAnimationFrame(() => this.loop())
  }
}

/** 时间戳：优先 performance.now（浏览器一定有，Node 里兜底 Date.now）。 */
function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}
