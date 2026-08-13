import type { ReactNode } from 'react'

type EmptyStateProps = {
  title: string
  description?: string
  /** 이 기능이 실제로 구현되는 Phase (기획서 §21) */
  phase?: number
  children?: ReactNode
}

export default function EmptyState({ title, description, phase, children }: EmptyStateProps) {
  return (
    <section className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-16 text-center">
      {phase !== undefined && (
        <span className="rounded-full border border-line-strong px-2.5 py-0.5 font-mono text-[11px] tracking-wide text-ink-muted">
          Phase {phase}
        </span>
      )}
      <h2 className="text-base font-semibold text-ink">{title}</h2>
      {description && (
        <p className="max-w-md text-[13px] leading-relaxed text-ink-muted">{description}</p>
      )}
      {children}
    </section>
  )
}
