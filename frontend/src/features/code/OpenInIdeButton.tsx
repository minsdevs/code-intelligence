import { useState } from 'react'
import { openInIde } from '../../api/ide'
import type { IdeType } from '../../api/types'

type Props = {
  projectId: number
  filePath: string
  line: number
  ide?: IdeType
}

const IDE_OPTIONS: { value: IdeType; label: string }[] = [
  { value: 'vscode', label: 'VS Code' },
  { value: 'cursor', label: 'Cursor' },
  { value: 'intellij', label: 'IntelliJ' },
  { value: 'webstorm', label: 'WebStorm' },
]

export default function OpenInIdeButton({ projectId, filePath, line, ide: defaultIde }: Props) {
  const [selectedIde, setSelectedIde] = useState<IdeType>(defaultIde ?? 'vscode')
  const [warning, setWarning] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function handleOpen() {
    setWarning(null)
    setError(null)
    setLoading(true)
    try {
      const response = await openInIde(projectId, { filePath, line, ide: selectedIde })
      if (response.commitMismatch) {
        setWarning(
          `Snapshot commit (${response.snapshotCommit?.slice(0, 8)}) differs from current HEAD (${response.currentCommit?.slice(0, 8)}). File content may have changed.`,
        )
      }
      window.location.href = response.uri
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to open in IDE')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="inline-flex items-center gap-1">
      <select
        value={selectedIde}
        onChange={(e) => setSelectedIde(e.target.value as IdeType)}
        className="rounded border border-line bg-surface-2 px-1.5 py-0.5 text-[11px] text-ink"
        aria-label="Select IDE"
      >
        {IDE_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
      <button
        type="button"
        onClick={() => void handleOpen()}
        disabled={loading}
        className="rounded border border-line bg-surface-2 px-2 py-0.5 text-[11px] text-accent hover:bg-surface-3 disabled:opacity-60"
        title={`Open ${filePath}:${line} in ${selectedIde}`}
      >
        {loading ? '...' : 'Open in IDE'}
      </button>
      {warning && (
        <span className="text-[10px] text-warn" role="alert">
          ⚠️ {warning}
        </span>
      )}
      {error && (
        <span className="text-[10px] text-danger" role="alert">
          {error}
        </span>
      )}
    </div>
  )
}
