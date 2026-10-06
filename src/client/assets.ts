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
