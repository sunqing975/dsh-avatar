import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm'
import type { VRM } from '@pixiv/three-vrm'
import { VRMAnimationLoaderPlugin, createVRMAnimationClip } from '@pixiv/three-vrm-animation'

/** 表情自动重置延迟（毫秒），避免表情一直僵在脸上。 */
const EXPRESSION_RESET_MS = 5000

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
    vrm.scene.traverse((obj) => {
      obj.frustumCulled = false
    })
    this.mixer = new THREE.AnimationMixer(vrm.scene)
    this.scene.add(vrm.scene)
    // 按模型包围盒自动取景：保证人物完整入画（头顶/脚不裁切）。
    const box = new THREE.Box3().setFromObject(vrm.scene)
    const center = box.getCenter(new THREE.Vector3())
    const size = box.getSize(new THREE.Vector3())
    const fovRad = (this.camera.fov * Math.PI) / 180
    // 以人物高度为主导，留 15% 余量。
    const dist = (size.y / 2 / Math.tan(fovRad / 2)) * 1.15
    this.camera.position.set(center.x, center.y, center.z + dist)
    this.camera.lookAt(center.x, center.y + size.y * 0.08, center.z)
  }

  /**
   * 加载 VRMA 动作清单：每个动作 fetch 对应文件并绑定到当前 VRM 的骨骼。
   * 必须在 loadModel 之后调用。
   */
  async loadAnimations(names: string[], baseUrl: string): Promise<void> {
    const vrm = this.vrm
    if (!vrm) return
    const loader = new GLTFLoader()
    loader.register((parser) => new VRMAnimationLoaderPlugin(parser))
    for (const name of names) {
      try {
        const url = `${baseUrl}/animations/${encodeURIComponent(name)}.vrma`
        const gltf = await loader.loadAsync(url)
        const vrmAnimation = (gltf.userData.vrmAnimations ?? [])[0]
        if (!vrmAnimation) {
          // eslint-disable-next-line no-console
          console.warn('[dsh-avatar] motion %s has no vrmAnimations', name)
          continue
        }
        const clip = createVRMAnimationClip(vrmAnimation, vrm)
        this.clips.set(name, clip)
      } catch (err) {
        // 单个动作加载失败不影响其余动作。
        // eslint-disable-next-line no-console
        console.warn('[dsh-avatar] failed to load motion %s: %s', name, err instanceof Error ? err.message : err)
      }
    }
    // 有 idle 则常驻待机循环。
    if (this.clips.has('idle')) {
      this.playMotion('idle', true)
    }
  }

  /** 播放动作：切换前停掉其他动作。loop=true 用于 idle 待机循环。 */
  playMotion(name: string, loop = false): void {
    const mixer = this.mixer
    const clip = this.clips.get(name)
    if (!mixer || !clip) return
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
    const vrm = this.vrm
    if (!vrm?.expressionManager) return
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

  dispose(): void {
    this.disposed = true
    cancelAnimationFrame(this.rafId)
    if (this.resetTimer !== null) clearTimeout(this.resetTimer)
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
    if (this.vrm) this.vrm.update(delta)
    this.mixer?.update(delta)
    this.renderer.render(this.scene, this.camera)
    this.rafId = requestAnimationFrame(() => this.loop())
  }
}
