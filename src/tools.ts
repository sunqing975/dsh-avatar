import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { BlendShapeInfo } from './model-info.ts'
import type { PoseHub } from './pose.ts'

/**
 * 注册表情工具：LLM 调用 set_expression 后，把指令写进 PoseHub，
 * 浏览器侧轮询到变化再驱动数字人播表情。工具本体只登记状态，不做渲染。
 */
export function registerExpressionTool(ctx: Context, blendShapes: BlendShapeInfo[], hub: PoseHub): () => void {
  return ctx.tools.register(defineTool({
    name: 'set_expression',
    description: '设置侧边栏 AI 数字人的表情。调用后数字人会做出对应表情。',
    parameters: {
      expression: {
        type: 'string',
        required: true,
        enum: blendShapes.map(s => s.id),
        description: `要播放的表情：${blendShapes.map(s => s.label).join('、')}`,
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: { expression: { type: 'string' } },
        additionalProperties: false,
      },
      render: (args, value) => [{ type: 'text', text: `数字人表情已切换为「${value.expression}」` }],
    },
    async execute(args) {
      hub.deliver({ expression: args.expression })
      return { expression: args.expression }
    },
  }))
}

/**
 * 注册动作工具：LLM 调用 play_motion 后，把指令写进 PoseHub，
 * 浏览器侧轮询到变化再驱动数字人播放 VRMA 动作。enum 来自 assets/animations 目录扫描。
 */
export function registerMotionTool(ctx: Context, motions: string[], hub: PoseHub): () => void {
  return ctx.tools.register(defineTool({
    name: 'play_motion',
    description: '让侧边栏 AI 数字人播放一段动作。调用后数字人会做出对应动作，播完自动回到待机。',
    parameters: {
      motion: {
        type: 'string',
        required: true,
        enum: motions,
        description: `要播放的动作：${motions.join('、')}`,
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: { motion: { type: 'string' } },
        additionalProperties: false,
      },
      render: (args, value) => [{ type: 'text', text: `数字人动作已播放「${value.motion}」` }],
    },
    async execute(args) {
      hub.deliver({ motion: args.motion })
      return { motion: args.motion }
    },
  }))
}
