import { useState } from 'react'
import { exportSummary } from '../../api/export'

type Props = {
  projectId: number
}

export default function ExportButton({ projectId }: Props) {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleExport(format: 'markdown' | 'json') {
    setError(null)
    setLoading(true)
    setOpen(false)
    try {
      await exportSummary(projectId, format)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Export failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        disabled={loading}
        className="rounded-md border border-line bg-surface-2 px-3 py-1.5 text-[12px] text-ink hover:bg-surface-3 disabled:opacity-60"
        aria-label="Export analysis summary"
        aria-expanded={open}
      >
        {loading ? 'Exporting...' : '↓ Export Summary'}
      </button>
      {open && (
        <div className="absolute right-0 z-10 mt-1 rounded-md border border-line bg-surface-1 py-1 shadow-lg">
          <button
            type="button"
            onClick={() => void handleExport('markdown')}
            className="block w-full px-4 py-1.5 text-left text-[12px] text-ink hover:bg-surface-2"
          >
            Markdown (.md)
          </button>
          <button
            type="button"
            onClick={() => void handleExport('json')}
            className="block w-full px-4 py-1.5 text-left text-[12px] text-ink hover:bg-surface-2"
          >
            JSON (.json)
          </button>
        </div>
      )}
      {error && (
        <p className="mt-1 text-[11px] text-danger" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
