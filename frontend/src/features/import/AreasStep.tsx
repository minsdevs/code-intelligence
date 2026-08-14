import { useEffect, useState } from 'react'
import { ApiError, UnauthorizedError } from '../../api/client'
import { listAreas, updateAreaSelections } from '../../api/areas'
import { useT } from '../../lib/i18n'
import type { ProjectArea } from '../../api/types'
import { AREA_LABELS } from './wizard'

type AreasStepProps = {
  projectId: number
  onSaved: () => void
  onUnauthorized: () => void
}

export default function AreasStep({ projectId, onSaved, onUnauthorized }: AreasStepProps) {
  const t = useT()
  const [areas, setAreas] = useState<ProjectArea[] | null>(null)
  const [selected, setSelected] = useState<Record<string, boolean>>({})
  const [loadedProjectId, setLoadedProjectId] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const loading = loadedProjectId !== projectId

  useEffect(() => {
    let cancelled = false
    void listAreas(projectId)
      .then((data) => {
        if (cancelled) return
        setAreas(data)
        const next: Record<string, boolean> = {}
        for (const area of data) {
          next[area.areaType] = area.selected
        }
        setSelected(next)
        setLoadedProjectId(projectId)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        if (err instanceof UnauthorizedError) {
          onUnauthorized()
          return
        }
        setError(err instanceof ApiError ? err.message : t('areas.listError'))
        setLoadedProjectId(projectId)
      })
    return () => {
      cancelled = true
    }
  }, [projectId, onUnauthorized, t])

  const handleSave = async () => {
    if (!areas) return
    setSaving(true)
    setError(null)
    try {
      await updateAreaSelections(projectId, {
        selections: areas.map((area) => ({
          areaType: area.areaType,
          selected: selected[area.areaType] ?? false,
        })),
      })
      onSaved()
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized()
        return
      }
      setError(err instanceof ApiError ? err.message : t('areas.saveError'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex max-w-2xl flex-col gap-4">
      <div>
        <h2 className="text-[15px] font-semibold text-ink">{t('areas.title')}</h2>
        <p className="mt-1 text-[13px] leading-relaxed text-ink-muted">{t('areas.description')}</p>
      </div>

      {error && (
        <p role="alert" className="text-[12px] text-danger">
          {error}
        </p>
      )}

      {loading && <p className="text-[13px] text-ink-muted">{t('areas.loading')}</p>}

      {!loading && areas && areas.length === 0 && (
        <p className="text-[13px] text-ink-muted">{t('areas.empty')}</p>
      )}

      {!loading && areas && areas.length > 0 && (
        <ul className="flex max-h-[46vh] flex-col gap-2 overflow-y-auto">
          {areas.map((area) => {
            const checked = selected[area.areaType] ?? false
            const pct = Math.round(Math.min(1, Math.max(0, area.confidence)) * 100)
            const label = AREA_LABELS[area.areaType] ?? area.areaType
            return (
              <li key={area.areaType}>
                <label className="flex cursor-pointer flex-col gap-2 rounded-md border border-line bg-surface-1 px-3 py-3 has-[:focus-visible]:outline has-[:focus-visible]:outline-accent">
                  <div className="flex items-center gap-2.5">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(event) =>
                        setSelected((current) => ({
                          ...current,
                          [area.areaType]: event.target.checked,
                        }))
                      }
                      aria-label={label}
                      className="size-3.5 accent-accent"
                    />
                    <span className="font-mono text-[13px] text-ink">{label}</span>
                    <span className="ml-auto font-mono text-[11px] text-ink-faint">{pct}%</span>
                  </div>
                  <div
                    role="progressbar"
                    aria-label={`${label} confidence`}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={pct}
                    className="h-1 overflow-hidden rounded-full bg-surface-3"
                  >
                    <div className="h-full bg-accent" style={{ width: `${pct}%` }} />
                  </div>
                  {area.technologies.length > 0 && (
                    <p className="flex flex-wrap gap-1">
                      {area.technologies.map((tech) => (
                        <span
                          key={tech}
                          className="rounded border border-line-strong px-1.5 py-px font-mono text-[10px] text-ink-muted"
                        >
                          {tech}
                        </span>
                      ))}
                    </p>
                  )}
                  {area.evidences.length > 0 && (
                    <ul className="flex flex-col gap-0.5 font-mono text-[11px] text-ink-faint">
                      {area.evidences.map((evidence, index) => (
                        <li key={`${evidence.filePath}-${index}`}>
                          {evidence.filePath}
                          {evidence.line != null ? `:${evidence.line}` : ''}
                        </li>
                      ))}
                    </ul>
                  )}
                </label>
              </li>
            )
          })}
        </ul>
      )}

      <button
        type="button"
        disabled={loading || saving || areas === null}
        onClick={() => void handleSave()}
        className="w-fit rounded-md bg-accent px-3 py-1.5 text-[13px] font-medium text-surface-0 disabled:opacity-60"
      >
        {saving ? t('areas.saving') : t('areas.save')}
      </button>
    </div>
  )
}
