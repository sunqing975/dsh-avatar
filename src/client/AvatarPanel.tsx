import { useEffect, useRef, useState } from 'react'
import { avatarEvents, type ExpressionDetail, type MotionDetail } from './event-bus.ts'
import { AvatarController } from './vrm.ts'

const MODEL_URL = '/dsh-avatar/model.vrm'
const ASSETS_URL = '/dsh-avatar/assets'

/** 右栏 tab 的标题（tab chip 文案）。 */
export function AvatarTitle(): React.JSX.Element {
  return <span>数字人</span>
}

/** 右栏 tab 的内容：数字人常驻面板（VRM 渲染）。 */
export function AvatarBody(): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const controllerRef = useRef<AvatarController | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [message, setMessage] = useState<string | null>(null)

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
        // 拉取动作清单并加载 VRMA。
        const info = await (await fetch('/dsh-avatar/info')).json() as { animations?: string[] }
        await controller.loadAnimations(info.animations ?? [], ASSETS_URL)
        if (cancelled) return
        setState('ready')
      } catch (err) {
        if (cancelled) return
        setState('error')
        setMessage(err instanceof Error ? err.message : String(err))
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
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 12,
        padding: 8,
        height: '100%',
        boxSizing: 'border-box',
      }}
    >
      <div
        style={{
          position: 'relative',
          width: '100%',
          flex: 1,
          minHeight: 160,
          borderRadius: 8,
          overflow: 'hidden',
          background: 'linear-gradient(180deg, #1b2a4a 0%, #0e1626 100%)',
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
              padding: 12,
              textAlign: 'center',
            }}
          >
            {state === 'loading' ? '正在加载数字人…' : `加载失败：${message ?? '未知错误'}`}
          </div>
        )}
      </div>
      <div style={{ fontSize: 12, color: '#8b9bb4', textAlign: 'center' }}>
        对话中让大模型调用表情/动作工具，数字人会做出反应
      </div>
    </div>
  )
}
