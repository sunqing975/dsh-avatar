/**
 * `/dsh-avatar/info` 资产条目的客户端解析。
 *
 * Host 侧资产注册表把资产发成对象（`AssetRef = { name, builtin }`，builtin 用于管理页
 * 决定是否显示「删除」）。浮层早年只按裸字符串处理，于是 `encodeURIComponent(entry)`
 * 得到 `%5Bobject%20Object%5D` —— 每个动作 URL 都 404，clips 全空、没有 idle，
 * 数字人僵在 bind pose（双臂平举、毫无动作）。这里集中做形状归一，别再各处手写。
 */

/** 资产条目：Host 现在发 `{ name, builtin }`，同时兼容裸名字符串。 */
export type AssetEntry = string | { name: string }

export function assetName(entry: AssetEntry): string {
  return typeof entry === 'string' ? entry : entry.name
}

export function assetNames(entries: readonly AssetEntry[] | null | undefined): string[] {
  return (entries ?? []).map(assetName).filter(name => name.length > 0)
}

/** 动作文件 URL：`<baseUrl>/<name>.vrma`（名字必须 encode，内置动作含空格，如 `Body Block`）。 */
export function motionUrl(baseUrl: string, entry: AssetEntry): string {
  return `${baseUrl}/${encodeURIComponent(assetName(entry))}.vrma`
}

/**
 * 把动作清单拆成「先加载的待机素材」与「后台并行加载的其余动作」。
 *
 * 为什么要拆：内置动作加起来约 3.6MB，其中 `Body Block.vrma` 一个就 2.6MB（JSON+base64），
 * 而它恰好排在清单第一个。早年是**串行**把全部动作下完才播待机 —— 每次打开页面或切换资产，
 * 数字人都要先举着手在 bind pose 站好几秒。现在待机先单独加载并立刻播，其余动作并行后台拉。
 */
export function planMotionLoad<T extends AssetEntry>(
  entries: readonly T[],
  idleName: string | null,
): { idle: T | null; rest: T[] } {
  const idle = idleName === null ? null : entries.find(entry => assetName(entry) === idleName) ?? null
  return { idle, rest: entries.filter(entry => entry !== idle) }
}
