import { useEffect, useRef, useState } from 'react'
import { avatarEvents, type ExpressionDetail, type MotionDetail } from './event-bus.ts'
import { AvatarController } from './vrm.ts'

const MODEL_URL = '/dsh-avatar/model.vrm'
const ASSETS_URL = '/dsh-avatar/assets'

/**
 * 数字人常驻浮层：挂在 dsh 全局前层（shell.overlay），
 * 所有页面/会话常驻可见，不依赖任何 tab 或会话。
 */
export function AvatarFloating(): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const controllerRef = useRef<AvatarController | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')

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

  return (
    <div
      data-dsh-avatar
      style={{
        position: 'fixed',
        right: 16,
        bottom: 16,
        width: 220,
        height: 300,
        borderRadius: 12,
        overflow: 'hidden',
        pointerEvents: 'auto',
        boxShadow: '0 8px 28px rgba(0,0,0,0.45)',
        border: '1px solid rgba(255,255,255,0.08)',
        background: 'linear-gradient(180deg, #1b2a4a 0%, #0e1626 100%)',
        zIndex: 2147483000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <canvas
        ref={canvasRef}
        style={{ display: 'block', width: '100%', height: '100%' }}
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
