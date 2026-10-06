import { useCallback, useEffect, useRef, useState } from 'react'
import { emitAssetsChanged } from './event-bus.ts'

/**
 * 管理页（右侧边栏 tab 正文）：查看/导入/切换/删除数字人资产（VRM 模型 + VRMA 动作）。
 * 所有写操作成功后广播 assets-changed，数字人浮层随即重载。
 */

interface AssetRef {
  name: string
  builtin: boolean
}

interface AssetInfo {
  currentModel: string
  models: AssetRef[]
  blendShapes: string[]
  modelUrl: string
  animations: AssetRef[]
}

const POST_JSON_HEADERS = { 'Content-Type': 'application/json' }

export function AssetManagerPanel(): React.JSX.Element {
  const [info, setInfo] = useState<AssetInfo | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const modelInputRef = useRef<HTMLInputElement>(null)
  const motionInputRef = useRef<HTMLInputElement>(null)

  const load = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch('/dsh-avatar/info')
      if (!res.ok) throw new Error(`info ${res.status}`)
      setInfo(await res.json() as AssetInfo)
      setError(null)
    } catch (err) {
      setError(`加载资产清单失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function runAction(action: () => Promise<unknown>): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      await action()
      emitAssetsChanged()
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  async function uploadFile(kind: 'model' | 'motion', file: File): Promise<void> {
    const res = await fetch(`/dsh-avatar/upload?kind=${kind}&name=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      body: file,
    })
    const body = await res.json().catch(() => null) as { error?: string } | null
    if (!res.ok || !body) throw new Error(body?.error ?? `上传失败（${res.status}）`)
  }

  async function selectModel(name: string): Promise<void> {
    const res = await fetch('/dsh-avatar/select-model', {
      method: 'POST',
      headers: POST_JSON_HEADERS,
      body: JSON.stringify({ name }),
    })
    const body = await res.json().catch(() => null) as { error?: string } | null
    if (!res.ok || !body) throw new Error(body?.error ?? `切换失败（${res.status}）`)
  }

  async function deleteAsset(kind: 'model' | 'motion', name: string): Promise<void> {
    const res = await fetch(`/dsh-avatar/delete?kind=${kind}&name=${encodeURIComponent(name)}`, { method: 'POST' })
    const body = await res.json().catch(() => null) as { error?: string } | null
    if (!res.ok || !body) throw new Error(body?.error ?? `删除失败（${res.status}）`)
  }

  return (
    <div style={styles.wrap}>
      {error !== null && <div style={styles.error}>{error}</div>}

      <section style={styles.section}>
        <h3 style={styles.sectionTitle}>模型（VRM）</h3>
        <p style={styles.hint}>当前：{info?.currentModel ?? '…'}</p>
        <ul style={styles.list}>
          {(info?.models ?? []).map(model => (
            <li key={model.name} style={styles.row}>
              <span style={styles.rowName}>
                {model.name}
                {model.name === info?.currentModel && <span style={styles.badgeCurrent}>当前</span>}
                {model.builtin && <span style={styles.badgeBuiltin}>内置</span>}
              </span>
              <span style={styles.rowActions}>
                {model.name !== info?.currentModel && (
                  <button style={styles.btn} disabled={busy} onClick={() => void runAction(() => selectModel(model.name))}>
                    切换
                  </button>
                )}
                {!model.builtin && (
                  <button style={styles.btnDanger} disabled={busy} onClick={() => void runAction(() => deleteAsset('model', model.name))}>
                    删除
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
        <input
          ref={modelInputRef}
          type="file"
          accept=".vrm"
          style={{ display: 'none' }}
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) void runAction(() => uploadFile('model', file))
            e.target.value = ''
          }}
        />
        <button style={styles.btnPrimary} disabled={busy} onClick={() => modelInputRef.current?.click()}>
          导入 VRM 模型
        </button>
      </section>

      <section style={styles.section}>
        <h3 style={styles.sectionTitle}>动作（VRMA）</h3>
        <ul style={styles.list}>
          {(info?.animations ?? []).map(motion => (
            <li key={motion.name} style={styles.row}>
              <span style={styles.rowName}>
                {motion.name}
                {motion.builtin && <span style={styles.badgeBuiltin}>内置</span>}
              </span>
              <span style={styles.rowActions}>
                {!motion.builtin && (
                  <button style={styles.btnDanger} disabled={busy} onClick={() => void runAction(() => deleteAsset('motion', motion.name))}>
                    删除
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
        <input
          ref={motionInputRef}
          type="file"
          accept=".vrma"
          style={{ display: 'none' }}
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) void runAction(() => uploadFile('motion', file))
            e.target.value = ''
          }}
        />
        <button style={styles.btnPrimary} disabled={busy} onClick={() => motionInputRef.current?.click()}>
          导入 VRMA 动作
        </button>
      </section>

      <p style={styles.foot}>导入后工具参数自动更新，无需重启。导入的模型会自动设为当前模型。</p>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  wrap: {
    display: 'flex',
    flexDirection: 'column',
    gap: 16,
    padding: '12px 14px',
    fontSize: 13,
    color: '#1f2329',
    boxSizing: 'border-box',
  },
  section: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  sectionTitle: {
    margin: 0,
    fontSize: 14,
    fontWeight: 600,
  },
  hint: {
    margin: 0,
    color: '#8b9bb4',
    fontSize: 12,
  },
  list: {
    listStyle: 'none',
    margin: 0,
    padding: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    padding: '6px 8px',
    borderRadius: 6,
    background: 'rgba(128,128,128,0.08)',
  },
  rowName: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  rowActions: {
    display: 'flex',
    gap: 6,
    flexShrink: 0,
  },
  badgeCurrent: {
    fontSize: 11,
    color: '#fff',
    background: '#3370ff',
    borderRadius: 4,
    padding: '1px 5px',
  },
  badgeBuiltin: {
    fontSize: 11,
    color: '#646a73',
    border: '1px solid rgba(128,128,128,0.35)',
    borderRadius: 4,
    padding: '1px 5px',
  },
  btn: {
    fontSize: 12,
    padding: '3px 8px',
    borderRadius: 4,
    border: '1px solid rgba(128,128,128,0.4)',
    background: 'transparent',
    cursor: 'pointer',
    color: 'inherit',
  },
  btnPrimary: {
    fontSize: 12,
    padding: '6px 10px',
    borderRadius: 4,
    border: 'none',
    background: '#3370ff',
    color: '#fff',
    cursor: 'pointer',
  },
  btnDanger: {
    fontSize: 12,
    padding: '3px 8px',
    borderRadius: 4,
    border: '1px solid rgba(229,72,77,0.5)',
    background: 'transparent',
    color: '#e5484d',
    cursor: 'pointer',
  },
  error: {
    color: '#e5484d',
    fontSize: 12,
    padding: '6px 8px',
    borderRadius: 6,
    background: 'rgba(229,72,77,0.1)',
  },
  foot: {
    margin: 0,
    color: '#8b9bb4',
    fontSize: 12,
    lineHeight: 1.5,
  },
}
