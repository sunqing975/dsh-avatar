/**
 * 资产注册表：内置资产（插件包 assets/）+ 用户导入资产（dsh 数据目录）的统一视图。
 *
 * 为什么独立数据目录而不是写插件包：
 * - GitHub/npm 安装时插件包在 node_modules 里，语义上是只读的；
 * - 用户导入的资产属于用户数据，与代码升级解耦（升级插件不丢用户资产）。
 * 数据目录默认 <dshHome>/dsh-avatar/，可用环境变量 DSH_AVATAR_DATA_DIR 覆盖（测试用）。
 *
 * 同名冲突规则：用户文件优先于内置文件（用户导入即覆盖同名的内置资产），
 * 删除用户文件后内置资产自动恢复。内置资产本身不可删除。
 */

import { mkdir, readFile, readdir, writeFile, unlink } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'

const GLB_MAGIC = 0x46546c67 // 'glTF' —— VRM 与 VRMA 都是 GLB 容器

/** 上传大小上限：模型 128MB，动作 64MB。 */
const MAX_MODEL_BYTES = 128 * 1024 * 1024
const MAX_MOTION_BYTES = 64 * 1024 * 1024

/** 一项资产。 */
export interface AssetRef {
  /** 资产名（去扩展名），工具 enum 与 URL 都用它。 */
  name: string
  /** 是否来自插件包内置目录。 */
  builtin: boolean
}

/** 当前模型名等可变状态，持久化在数据目录。 */
interface StateFile {
  currentModel?: string
}

function resolveDshHome(): string {
  const env = process.env.DSH_HOME
  if (env !== undefined && env.trim().length > 0) return path.resolve(env)
  return path.join(homedir(), '.dsh')
}

/** 把上传文件名规范化为安全资产名（去扩展名）；非法返回 null。 */
function sanitizeAssetName(filename: string, ext: '.vrm' | '.vrma'): string | null {
  let base = path.basename(filename)
  if (base.toLowerCase().endsWith(ext)) base = base.slice(0, -ext.length)
  base = base.trim()
  if (base === '' || base === '.' || base === '..') return null
  if (base.length > 64) return null
  // 不允许路径分隔符与不可见字符混入（basename 已挡分隔符，这里兜底）。
  if (/[\\/\0]/.test(base)) return null
  return base
}

export class AssetRegistry {
  readonly userModelsDir: string
  readonly userAnimationsDir: string
  private readonly builtinModelsDir: string
  private readonly builtinAnimationsDir: string
  private readonly statePath: string
  private readonly defaultModelName: string
  private currentModelName: string

  constructor(packageRoot: string, configModelPath: string) {
    this.builtinModelsDir = path.join(packageRoot, 'assets', 'models')
    this.builtinAnimationsDir = path.join(packageRoot, 'assets', 'animations')
    const dataDir = process.env.DSH_AVATAR_DATA_DIR ?? path.join(resolveDshHome(), 'dsh-avatar')
    this.userModelsDir = path.join(dataDir, 'models')
    this.userAnimationsDir = path.join(dataDir, 'animations')
    this.statePath = path.join(dataDir, 'state.json')
    this.defaultModelName = path.basename(configModelPath).replace(/\.vrm$/i, '') || 'nuomi'

    let saved: StateFile = {}
    try {
      saved = JSON.parse(readFileSyncSafe(this.statePath) ?? '{}') as StateFile
    } catch {
      saved = {}
    }
    this.currentModelName = typeof saved.currentModel === 'string' && saved.currentModel !== ''
      ? saved.currentModel
      : this.defaultModelName
  }

  /** 确保用户目录存在（上传/读取前调用）。 */
  async ensureDirs(): Promise<void> {
    await mkdir(this.userModelsDir, { recursive: true })
    await mkdir(this.userAnimationsDir, { recursive: true })
  }

  /** 模型清单：内置在前、用户在后；同名时内置条目隐藏（用户优先）。 */
  async listModels(): Promise<AssetRef[]> {
    const [builtin, user] = await Promise.all([
      scanDir(this.builtinModelsDir, '.vrm', true),
      scanDir(this.userModelsDir, '.vrm', false),
    ])
    return mergeAssets(builtin, user)
  }

  /** 动作清单：内置在前、用户在后；同名时内置条目隐藏（用户优先）。 */
  async listAnimations(): Promise<AssetRef[]> {
    const [builtin, user] = await Promise.all([
      scanDir(this.builtinAnimationsDir, '.vrma', true),
      scanDir(this.userAnimationsDir, '.vrma', false),
    ])
    return mergeAssets(builtin, user)
  }

  /** 当前生效的模型名（缺省回退内置默认；内置默认也不存在时取清单第一个）。 */
  async currentModel(): Promise<string> {
    const models = await this.listModels()
    if (models.some(m => m.name === this.currentModelName)) return this.currentModelName
    if (models.length === 0) throw new Error('no VRM model available')
    const fallback = models[0]!.name
    this.currentModelName = fallback
    return fallback
  }

  /** 切换当前模型并持久化。 */
  async setCurrentModel(name: string): Promise<void> {
    const models = await this.listModels()
    if (!models.some(m => m.name === name)) throw new Error(`model not found: ${name}`)
    this.currentModelName = name
    await this.saveState()
  }

  /** 解析模型文件绝对路径（用户优先→内置）。 */
  async modelFile(name: string): Promise<string | null> {
    return this.resolveFile(this.userModelsDir, this.builtinModelsDir, name, '.vrm')
  }

  /** 解析动作文件绝对路径（用户优先→内置）。 */
  async animationFile(name: string): Promise<string | null> {
    return this.resolveFile(this.userAnimationsDir, this.builtinAnimationsDir, name, '.vrma')
  }

  /** 导入 VRM：写用户目录并切换为当前模型；返回资产名。 */
  async importModel(buffer: Buffer, filename: string): Promise<string> {
    assertGlb(buffer)
    const name = sanitizeAssetName(filename, '.vrm')
    if (name === null) throw new Error('invalid model file name')
    await this.ensureDirs()
    await writeFile(path.join(this.userModelsDir, `${name}.vrm`), buffer, { flag: 'w' })
    this.currentModelName = name
    await this.saveState()
    return name
  }

  /** 导入 VRMA：写用户目录；返回资产名。 */
  async importAnimation(buffer: Buffer, filename: string): Promise<string> {
    assertGlb(buffer)
    const name = sanitizeAssetName(filename, '.vrma')
    if (name === null) throw new Error('invalid motion file name')
    await this.ensureDirs()
    await writeFile(path.join(this.userAnimationsDir, `${name}.vrma`), buffer, { flag: 'w' })
    return name
  }

  /** 删除用户导入的模型；返回是否删除了当前模型。 */
  async removeModel(name: string): Promise<boolean> {
    const removed = await removeUserFile(this.userModelsDir, name, '.vrm')
    if (removed && this.currentModelName === name) {
      // 当前模型被删：回退内置默认（下次 currentModel() 解析）。
      this.currentModelName = this.defaultModelName
      await this.saveState()
      return true
    }
    return false
  }

  /** 删除用户导入的动作；返回是否删除了文件。 */
  async removeAnimation(name: string): Promise<boolean> {
    return removeUserFile(this.userAnimationsDir, name, '.vrma')
  }

  private async saveState(): Promise<void> {
    await this.ensureDirs()
    await writeFile(this.statePath, JSON.stringify({ currentModel: this.currentModelName }), { flag: 'w' })
  }

  private async resolveFile(userDir: string, builtinDir: string, name: string, ext: '.vrm' | '.vrma'): Promise<string | null> {
    if (!/^[^\\/\0]+$/.test(name) || name.startsWith('.') || name === '..') return null
    const userPath = path.join(userDir, `${name}${ext}`)
    try {
      await readFile(userPath)
      return userPath
    } catch {
      // 用户目录没有，回退内置。
    }
    const builtinPath = path.join(builtinDir, `${name}${ext}`)
    try {
      await readFile(builtinPath)
      return builtinPath
    } catch {
      return null
    }
  }
}

/** 同步读小文件；文件不存在或解析失败返回 null（启动时容忍脏状态）。 */
function readFileSyncSafe(p: string): string | null {
  try {
    return readFileSync(p, 'utf8')
  } catch {
    return null
  }
}

async function scanDir(dir: string, ext: '.vrm' | '.vrma', builtin: boolean): Promise<AssetRef[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries
      .filter(e => e.isFile() && e.name.toLowerCase().endsWith(ext))
      .map(e => ({ name: e.name.slice(0, -ext.length), builtin }))
      .sort((a, b) => a.name.localeCompare(b.name))
  } catch {
    return []
  }
}

/** 合并清单：内置在前，用户同名时隐藏内置条目（用户优先）。 */
function mergeAssets(builtin: AssetRef[], user: AssetRef[]): AssetRef[] {
  const userNames = new Set(user.map(u => u.name))
  return [...builtin.filter(b => !userNames.has(b.name)), ...user]
}

function assertGlb(buffer: Buffer): void {
  if (buffer.length < 12) throw new Error('file too small: not a GLB container')
  if (buffer.readUInt32LE(0) !== GLB_MAGIC) throw new Error('not a GLB file (VRM/VRMA must be GLB)')
}

async function removeUserFile(userDir: string, name: string, ext: '.vrm' | '.vrma'): Promise<boolean> {
  if (!/^[^\\/\0]+$/.test(name) || name.startsWith('.') || name === '..') return false
  const p = path.join(userDir, `${name}${ext}`)
  try {
    await unlink(p)
    return true
  } catch {
    return false
  }
}

export { MAX_MODEL_BYTES, MAX_MOTION_BYTES }
