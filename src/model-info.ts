/**
 * 解析 VRM 0.x GLB 文件的 blend shape（表情）清单。
 *
 * GLB = 12 字节头 + chunks；第一个 chunk 是 JSON（0x4E4F534A）。
 * 表情定义在 gltf.extensions.VRM.blendShapeMaster.blendShapeGroups，
 * 每个 group 携带 presetName（标准表情）或 customName（自定义）。
 */

export interface BlendShapeInfo {
  /** 播放时传给 expressionManager 的表达式 id（小写）。 */
  id: string
  /** 展示给模型/用户的名称。 */
  label: string
}

const GLB_MAGIC = 0x46546c67 // 'glTF'
const GLB_HEADER_LEN = 12
const CHUNK_HEADER_LEN = 8
const JSON_CHUNK_TYPE = 0x4e4f534a // 'JSON'

export function parseBlendShapesFromGlb(buffer: ArrayBuffer): BlendShapeInfo[] {
  const view = new DataView(buffer)
  if (view.byteLength < GLB_HEADER_LEN + CHUNK_HEADER_LEN || view.getUint32(0, true) !== GLB_MAGIC) {
    throw new Error('not a GLB file')
  }
  const chunkLength = view.getUint32(GLB_HEADER_LEN, true)
  const chunkType = view.getUint32(GLB_HEADER_LEN + 4, true)
  if (chunkType !== JSON_CHUNK_TYPE) throw new Error('first chunk is not JSON')
  const jsonStart = GLB_HEADER_LEN + CHUNK_HEADER_LEN
  if (view.byteLength < jsonStart + chunkLength) throw new Error('truncated GLB JSON chunk')
  const jsonBytes = new Uint8Array(buffer, jsonStart, chunkLength)
  const jsonText = new TextDecoder().decode(jsonBytes)
  const gltf = JSON.parse(jsonText) as {
    extensions?: { VRM?: { blendShapeMaster?: { blendShapeGroups?: Array<{ presetName?: string; name?: string }> } } }
  }
  const groups = gltf.extensions?.VRM?.blendShapeMaster?.blendShapeGroups ?? []
  const seen = new Set<string>()
  const out: BlendShapeInfo[] = []
  for (const group of groups) {
    const preset = (group.presetName ?? 'unknown').toLowerCase()
    const name = (group.name ?? '').trim()
    const id = preset !== 'unknown' && preset !== '' ? preset : name.toLowerCase()
    if (id === '' || seen.has(id)) continue
    seen.add(id)
    out.push({ id, label: preset !== 'unknown' && preset !== '' ? preset : name })
  }
  return out
}
