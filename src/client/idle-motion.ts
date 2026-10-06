/**
 * 待机动作（idle）的组装。
 *
 * 结论先行（踩过两次坑）：
 *   1. 内置 `idle.vrma` 幅度太小（只有小臂约 5°，脊柱/头几乎不动），300px 的浮层里看不出在动；
 *   2. 自己「程序化加胯部位移/摆动」会让**整条腿连同脚一起动** —— 没有 IK 补偿时，
 *      看起来就是整个人在地上飘/滑，比呆更糟。
 *
 * 所以现在的策略是：**直接用一条真实的待机动作素材**（`idle_stand.vrma`，来源见
 * assets/animations/ATTRIBUTION.md），默认原样播放、不做程序化加减；只做两件安全的事：
 *   - `lockHipsTranslation`（默认开）：丢掉胯部位移轨道，只保留旋转。
 *     胯部位移=整个人（含脚）平移，是「飘」的直接来源；锁掉后角色必然站在原处。
 *   - 可选 `gain` 幅度放大（默认 1 = 原样使用），给「还想更大一点」留个旋钮。
 *
 * 素材缺失/损坏时才会退化成纯程序化的上半身待机（手臂垂下 + 呼吸/点头/重心左右摆），
 * 且**完全不碰胯部**（既不位移也不旋转），保证不会飘。
 *
 * console 调参（刷新生效）：`window.__dshAvatarIdle = { motion, gain, amp, lockHipsTranslation, procedural }`
 */
import * as THREE from 'three'
import type { VRM, VRMHumanBoneName } from '@pixiv/three-vrm'

/** 默认优先使用的待机素材名（按顺序取第一个存在的）；都缺就退化为程序化。 */
export const IDLE_MOTION_PREFERENCE = ['idle_stand', 'idle'] as const

/** 幅度放大倍数：1 = 原样使用素材（默认），>1 只放大偏差、不改变姿势。 */
export const IDLE_GAIN = 1

/** 程序化兜底的幅度倍数（1 = 下表数值）。 */
export const IDLE_AMP = 1

/** 程序化兜底的循环时长（秒）。 */
export const IDLE_PROCEDURAL_SECONDS = 6

/** 采样密度：30fps 足够，插值交给 mixer。 */
const SAMPLE_FPS = 30

/** 程序化兜底驱动的骨骼：**只有上半身**（胯部一动全身跟着动，必飘）。 */
const FALLBACK_BONES = ['spine', 'chest', 'upperChest', 'neck', 'head'] as const

type Axis = 'x' | 'y' | 'z'
/** 单轴摆动：[轴, 幅度(度), 每循环次数, 相位(弧度)]。 */
type Swing = readonly [Axis, number, number, number]

/** 上半身程序化摆动：呼吸（2 次/循环）+ 轻微侧倾/转身 + 点头转头（相位错开）。 */
const FALLBACK_SWINGS: ReadonlyArray<{ bone: string; swings: readonly Swing[] }> = [
  { bone: 'spine', swings: [['x', 1.8, 2, 0], ['z', -1.4, 1, 0]] },
  { bone: 'chest', swings: [['x', 2.2, 2, 0.2], ['z', -1.0, 1, 0.1]] },
  { bone: 'upperChest', swings: [['x', 1.8, 2, 0.4]] },
  { bone: 'neck', swings: [['x', 2.2, 1, 1.2], ['y', 3.0, 1, 0.4]] },
  { bone: 'head', swings: [['x', 3.6, 1, 1.6], ['y', 5.0, 1, 0.9], ['z', 1.5, 1, 2.1]] },
]

/** 程序化兜底的手臂摆动（没有素材时用，避免只剩一个木头人）。 */
const FALLBACK_ARM_SWINGS: ReadonlyArray<{ bone: string; swings: readonly Swing[] }> = [
  { bone: 'leftShoulder', swings: [['x', 1.6, 1, 0.3]] },
  { bone: 'rightShoulder', swings: [['x', 1.6, 1, 0.9]] },
  { bone: 'leftUpperArm', swings: [['x', 3.0, 1, 0.2], ['z', 1.6, 1, 0.6]] },
  { bone: 'rightUpperArm', swings: [['x', 3.0, 1, 0.8], ['z', -1.6, 1, 0.2]] },
  { bone: 'leftLowerArm', swings: [['x', 4.0, 2, 0.5]] },
  { bone: 'rightLowerArm', swings: [['x', 4.0, 2, 1.1]] },
]

/** 兜底时把手臂从 T-pose 放下来的静态偏移（与真实待机素材的姿势方向一致）。 */
const ARM_DOWN_DEG = 62

export interface IdleOptions {
  /** 优先使用的待机素材名（按顺序取第一个存在的）。 */
  motion?: readonly string[]
  /** 素材幅度放大倍数，1 = 原样使用。 */
  gain?: number
  /** 锁住胯部位移（默认开）：胯平移会让整个人连脚一起滑，是「飘」的根源。 */
  lockHipsTranslation?: boolean
  /** 在素材之上再叠加程序化上半身摆动（默认关：直接用素材）。 */
  procedural?: boolean
  /** 程序化摆动幅度倍数。 */
  amp?: number
  /** 程序化循环秒数。 */
  proceduralSeconds?: number
}

/** 读取 console 里的调试覆盖：`window.__dshAvatarIdle = { motion, gain, amp, … }`。 */
export function idleOptionsFromWindow(win: Window & typeof globalThis): IdleOptions {
  const override = (win as unknown as { __dshAvatarIdle?: IdleOptions }).__dshAvatarIdle
  return {
    motion: override?.motion ?? IDLE_MOTION_PREFERENCE,
    gain: override?.gain ?? IDLE_GAIN,
    lockHipsTranslation: override?.lockHipsTranslation ?? true,
    procedural: override?.procedural ?? false,
    amp: override?.amp ?? IDLE_AMP,
    proceduralSeconds: override?.proceduralSeconds ?? IDLE_PROCEDURAL_SECONDS,
  }
}

/** 按优先级挑出可用的待机素材名。 */
export function pickIdleMotion(
  available: Iterable<string>,
  preference: readonly string[] = IDLE_MOTION_PREFERENCE,
): string | null {
  const names = new Set(available)
  for (const name of preference) if (names.has(name)) return name
  return null
}

/** 某个通道的节点名（`Normalized_Head.quaternion` → `Normalized_Head`）。 */
export function trackNodeName(track: THREE.KeyframeTrack): string {
  return track.name.split('.')[0] ?? ''
}

/**
 * 把 clip 的**偏差**放大：以每个通道的首帧为基准，
 * 四元数走 `ref * slerp(identity, ref⁻¹·q, gain)`（沿同一旋转方向外推），
 * 向量走 `ref + (v - ref) * gain`。姿势（基准帧）保持不变，只把动作做大。
 */
export function amplifyClip(clip: THREE.AnimationClip, gain: number): THREE.AnimationClip {
  const tracks = clip.tracks.map((track) => {
    // 用 ValueTypeName 分派而不是 instanceof：bundle 内联的 three 与宿主/测试里的 three
    // 可能是两份拷贝，跨拷贝 instanceof 会失效（本插件就把 three 打包进了 client bundle）。
    if (track.ValueTypeName === 'quaternion') {
      return amplifyQuaternionTrack(track as THREE.QuaternionKeyframeTrack, gain)
    }
    if (track.ValueTypeName === 'vector') {
      return amplifyVectorTrack(track as THREE.VectorKeyframeTrack, gain)
    }
    return track
  })
  return new THREE.AnimationClip(clip.name, clip.duration, tracks)
}

const IDENTITY = new THREE.Quaternion()

function amplifyQuaternionTrack(track: THREE.QuaternionKeyframeTrack, gain: number): THREE.QuaternionKeyframeTrack {
  const ref = new THREE.Quaternion().fromArray(track.values, 0)
  const inverse = ref.clone().invert()
  const delta = new THREE.Quaternion()
  const scaled = new THREE.Quaternion()
  const out = new Float32Array(track.values.length)
  for (let i = 0; i < track.values.length; i += 4) {
    delta.fromArray(track.values, i).premultiply(inverse)
    scaled.copy(IDENTITY).slerp(delta, gain)
    delta.copy(ref).multiply(scaled)
    delta.toArray(out, i)
  }
  return new THREE.QuaternionKeyframeTrack(track.name, track.times, out)
}

function amplifyVectorTrack(track: THREE.VectorKeyframeTrack, gain: number): THREE.VectorKeyframeTrack {
  const ref = new THREE.Vector3().fromArray(track.values, 0)
  const out = new Float32Array(track.values.length)
  const v = new THREE.Vector3()
  for (let i = 0; i < track.values.length; i += 3) {
    v.fromArray(track.values, i).sub(ref).multiplyScalar(gain).add(ref)
    v.toArray(out, i)
  }
  return new THREE.VectorKeyframeTrack(track.name, track.times, out)
}

function boneNode(vrm: VRM, bone: string): THREE.Object3D | null {
  return vrm.humanoid?.getNormalizedBoneNode?.(bone as VRMHumanBoneName) ?? null
}

/** 某个通道的首帧值（用作程序化摆动的基准姿势）。 */
function firstFrameQuaternion(clip: THREE.AnimationClip | null | undefined, nodeName: string): THREE.Quaternion | null {
  const track = clip?.tracks.find(t => t.name === `${nodeName}.quaternion`)
  if (!track || track.ValueTypeName !== 'quaternion') return null
  return new THREE.Quaternion().fromArray(track.values, 0)
}

/** 按「整数次/循环」的正弦采样，保证 t=0 与 t=duration 完全相等（无缝循环）。 */
function proceduralQuaternionTrack(
  node: THREE.Object3D,
  swings: readonly Swing[],
  duration: number,
  amp: number,
  base: THREE.Quaternion,
): THREE.QuaternionKeyframeTrack {
  const steps = Math.max(24, Math.round(duration * SAMPLE_FPS))
  const times = new Float32Array(steps + 1)
  const values = new Float32Array((steps + 1) * 4)
  const euler = new THREE.Euler(0, 0, 0, 'YXZ')
  const delta = new THREE.Quaternion()
  const q = new THREE.Quaternion()
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * duration
    times[i] = t
    let x = 0
    let y = 0
    let z = 0
    for (const [axis, deg, cycles, phase] of swings) {
      const value = THREE.MathUtils.DEG2RAD * deg * amp * Math.sin((2 * Math.PI * cycles * t) / duration + phase)
      if (axis === 'x') x += value
      else if (axis === 'y') y += value
      else z += value
    }
    euler.set(x, y, z, 'YXZ')
    delta.setFromEuler(euler)
    q.copy(base).multiply(delta)
    q.toArray(values, i * 4)
  }
  return new THREE.QuaternionKeyframeTrack(`${node.name}.quaternion`, times, values)
}

/** 手臂垂下偏移：绕 Z 轴把 normalized 骨骼从 T-pose 转下来（左右反向）。 */
function armDownQuaternion(base: THREE.Quaternion, side: 'left' | 'right', bone: string): THREE.Quaternion {
  if (!bone.endsWith('UpperArm')) return base
  const deg = side === 'left' ? -ARM_DOWN_DEG : ARM_DOWN_DEG
  const delta = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, THREE.MathUtils.DEG2RAD * deg, 'YXZ'))
  return base.clone().multiply(delta)
}

/**
 * 组装待机 clip。
 *
 * @param base 真实待机素材（`createVRMAnimationClip` 的产物）；null 表示没有可用素材。
 */
export function buildIdleClip(
  vrm: VRM,
  base?: THREE.AnimationClip | null,
  options: IdleOptions = {},
): THREE.AnimationClip {
  const gain = options.gain ?? IDLE_GAIN
  const amp = options.amp ?? IDLE_AMP
  const lockHips = options.lockHipsTranslation ?? true
  const hipsName = boneNode(vrm, 'hips')?.name

  if (base) {
    const source = gain === 1 ? base : amplifyClip(base, gain)
    const tracks = lockHips && hipsName
      // 只丢胯部位移，保留其旋转（转身/重心左右摆仍然自然）。
      ? source.tracks.filter(track => track.name !== `${hipsName}.position`)
      : source.tracks
    const proceduralTracks = options.procedural ? fallbackTracks(vrm, source, amp, options.proceduralSeconds) : []
    return new THREE.AnimationClip('idle', source.duration, [...tracks, ...proceduralTracks])
  }
  // 没有素材：纯程序化兜底（不碰胯部，绝不飘）。
  return new THREE.AnimationClip(
    'idle',
    options.proceduralSeconds ?? IDLE_PROCEDURAL_SECONDS,
    fallbackTracks(vrm, null, amp, options.proceduralSeconds),
  )
}

/** 程序化兜底轨道：上半身摆动 + 手臂摆动（含垂下偏移）；不生成任何胯部轨道。 */
function fallbackTracks(
  vrm: VRM,
  base: THREE.AnimationClip | null,
  amp: number,
  proceduralSeconds = IDLE_PROCEDURAL_SECONDS,
): THREE.KeyframeTrack[] {
  const duration = Math.max(base?.duration ?? 0, proceduralSeconds)
  const tracks: THREE.KeyframeTrack[] = []
  for (const { bone, swings } of [...FALLBACK_SWINGS, ...FALLBACK_ARM_SWINGS]) {
    const node = boneNode(vrm, bone)
    if (!node) continue
    const authored = firstFrameQuaternion(base, node.name)
    const pose = authored ?? (bone.endsWith('UpperArm')
      ? armDownQuaternion(node.quaternion.clone(), bone.startsWith('left') ? 'left' : 'right', bone)
      : node.quaternion.clone())
    tracks.push(proceduralQuaternionTrack(node, swings, duration, amp, pose))
  }
  return tracks
}
