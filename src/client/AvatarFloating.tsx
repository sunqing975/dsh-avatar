import { useEffect, useRef, useState } from 'react'
import { avatarEvents, type ExpressionDetail, type MotionDetail } from './event-bus.ts'
import { AvatarController } from './vrm.ts'
import type { AssetEntry } from './assets.ts'

const MODEL_URL = '/dsh-avatar/model.vrm'
/** 动作服务前缀：/dsh-avatar/animations/<name>.vrma（用户导入优先于内置）。 */
const ANIMATIONS_URL = '/dsh-avatar/animations'

/** 浮层尺寸（人物显示区，透明背景）。 */
const WIDTH = 220
const HEIGHT = 300
/** 默认贴边间距。 */
const MARGIN = 12

interface AssetInfo {
  modelUrl?: string
  /** Host 发 `{ name, builtin }`（早期是裸字符串），归一化在 vrm.ts 的 loadAnimations 里做。 */
  animations?: readonly AssetEntry[]
}

/**
 * 数字人常驻浮层：挂在 dsh 全局前层（shell.overlay）。
 * 只显示人物本体（透明背景），可拖拽，位置跟随用户。
 * 资产变更（导入/切换/删除）后自动重载模型与动作。
 */
export function AvatarFloating(): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const controllerRef = useRef<AvatarController | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  // 拖拽位置（left/top 像素）；null 表示尚未拖过，用默认右下角。
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const dragRef = useRef<{ startX: number; startY: number; origLeft: number; origTop: number } | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    let cancelled = false

    async function fetchInfo(): Promise<AssetInfo> {
      // 模型地址与动作清单都以 Host 侧配置/资产注册表为准，避免客户端硬编码漂移。
      const res = await fetch('/dsh-avatar/info')
      if (!res.ok) throw new Error(`info ${res.status}`)
      return await res.json() as AssetInfo
    }

    async function mount(): Promise<void> {
      if (!canvas) return
      const controller = new AvatarController(canvas)
      controllerRef.current = controller
      setState('loading')
      try {
        await controller.init()
        const info = await fetchInfo()
        await controller.loadModel(info.modelUrl ?? MODEL_URL)
        await controller.loadAnimations(info.animations ?? [], ANIMATIONS_URL)
        if (cancelled) return
        setState('ready')
      } catch (err) {
        if (cancelled) return
        // eslint-disable-next-line no-console
        console.error('[dsh-avatar] avatar load failed:', err)
        setState('error')
      }
    }

    void mount()

    const onExpression = (event: Event) => {
      const detail = (event as CustomEvent<ExpressionDetail>).detail
      // eslint-disable-next-line no-console
      console.log('[dsh-avatar] floating received expression:', detail.expression)
      const w = window as unknown as { __dshAvatarLog?: string[] }
      w.__dshAvatarLog = w.__dshAvatarLog ?? []
      w.__dshAvatarLog.push(`floating:expression:${detail.expression}`)
      controllerRef.current?.playExpression(detail.expression)
    }
    const onMotion = (event: Event) => {
      const detail = (event as CustomEvent<MotionDetail>).detail
      // eslint-disable-next-line no-console
      console.log('[dsh-avatar] floating received motion:', detail.motion)
      const w = window as unknown as { __dshAvatarLog?: string[] }
      w.__dshAvatarLog = w.__dshAvatarLog ?? []
      w.__dshAvatarLog.push(`floating:motion:${detail.motion}`)
      controllerRef.current?.playMotion(detail.motion)
    }
    // 资产变更：重载数字人（复用 renderer，见 vrm.ts reload 注释）。
    const onAssetsChanged = () => {
      const controller = controllerRef.current
      if (!controller) return
      setState('loading')
      void (async () => {
        try {
          const info = await fetchInfo()
          await controller.reload(info.modelUrl ?? MODEL_URL, info.animations ?? [], ANIMATIONS_URL)
          if (!cancelled) setState('ready')
        } catch (err) {
          if (!cancelled) {
            // eslint-disable-next-line no-console
            console.error('[dsh-avatar] avatar reload failed:', err)
            setState('error')
          }
        }
      })()
    }
    avatarEvents.addEventListener('expression', onExpression)
    avatarEvents.addEventListener('motion', onMotion)
    avatarEvents.addEventListener('assets-changed', onAssetsChanged)

    return () => {
      cancelled = true
      avatarEvents.removeEventListener('expression', onExpression)
      avatarEvents.removeEventListener('motion', onMotion)
      avatarEvents.removeEventListener('assets-changed', onAssetsChanged)
      controllerRef.current?.dispose()
      controllerRef.current = null
    }
  }, [])

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    const current = pos ?? { left: window.innerWidth - WIDTH - MARGIN, top: window.innerHeight - HEIGHT - MARGIN }
    dragRef.current = { startX: e.clientX, startY: e.clientY, origLeft: current.left, origTop: current.top }
    ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
    e.preventDefault()
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    if (!drag) return
    const left = Math.min(Math.max(drag.origLeft + e.clientX - drag.startX, -WIDTH + 60), window.innerWidth - 60)
    const top = Math.min(Math.max(drag.origTop + e.clientY - drag.startY, 0), window.innerHeight - 60)
    setPos({ left, top })
  }

  const onPointerUp = (): void => {
    dragRef.current = null
  }

  const current = pos ?? { left: window.innerWidth - WIDTH - MARGIN, top: window.innerHeight - HEIGHT - MARGIN }

  return (
    <div
      data-dsh-avatar
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      style={{
        position: 'fixed',
        left: current.left,
        top: current.top,
        width: WIDTH,
        height: HEIGHT,
        pointerEvents: 'auto',
        cursor: 'grab',
        touchAction: 'none',
        zIndex: 2147483000,
        background: 'transparent',
      }}
    >
      <canvas
        ref={canvasRef}
        style={{ display: 'block', width: '100%', height: '100%', userSelect: 'none' }}
      />
      {state !== 'ready' && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: state === 'error' ? '#e5484d' : '#8b9bb4',
            fontSize: 12,
            pointerEvents: 'none',
          }}
        >
          {state === 'loading' ? '正在加载数字人…' : '数字人加载失败'}
        </div>
      )}
    </div>
  )
}
