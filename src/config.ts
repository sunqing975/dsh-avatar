import Schema from '@deepseek-ai/schemastery'

export interface Config {
  /** VRM 模型文件路径，相对于插件包根目录；浏览器通过 modelUrl 访问。 */
  modelPath: string
  /** 模型文件在 dsh web 上的访问路径。 */
  modelUrl: string
}

export const Config = Schema.object({
  modelPath: Schema.string().default('assets/models/nuomi.vrm'),
  modelUrl: Schema.string().default('/dsh-avatar/model.vrm'),
})
