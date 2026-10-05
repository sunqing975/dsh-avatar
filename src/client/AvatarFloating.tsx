import { useEffect, useRef, useState } from 'react'
import { avatarEvents, type ExpressionDetail, type MotionDetail } from './event-bus.ts'
import { AvatarController } from './vrm.ts'

const MODEL_URL = '/dsh-avatar/model.vrm'
const ASSETS_URL = '/dsh-avatar/assets'

/** 浮层尺寸（人物显示区，透明背景）。 */
const WIDTH = 220
const HEIGHT = 300
/** 默认贴边间距。 */
const MARGIN = 12

/**
 * 数字人常驻浮层：挂在 dsh 全局前层（shell.overlay）。
 * 只显示人物本体（透明背景），可拖拽，位置跟随用户。
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
    const controller = new AvatarController(canvas)
    controllerRef.current = controller
    let cancelled = false

    void (async () => {
      try {
        await controller.init()
        await controller.loadModel(MODEL_URL)
        // 拉取动作清单并加载 VRMA（idle 自动循环待机）。
        const info = await (await fetch('/dsh-avatar/info')).json() as { animations?: string[] }
        await controller.loadAnimations(info.animations ?? [], ASSETS_URL)
        if (cancelled) return
        setState('ready')
      } catch (err) {
        if (cancelled) return
        setState('error')
      }
    })()

    const onExpression = (event: Event) => {
      const detail = (event as CustomEvent<ExpressionDetail>).detail
      controller.playExpression(detail.expression)
    }
    const onMotion = (event: Event) => {
      const detail = (event as CustomEvent<MotionDetail>).detail
      controller.playMotion(detail.motion)
    }
    avatarEvents.addEventListener('expression', onExpression)
    avatarEvents.addEventListener('motion', onMotion)

    return () => {
      cancelled = true
      avatarEvents.removeEventListener('expression', onExpression)
      avatarEvents.removeEventListener('motion', onMotion)
      controller.dispose()
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
