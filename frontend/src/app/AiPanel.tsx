import type { PointerEvent as ReactPointerEvent } from 'react'
import { useUiStore } from '../stores/uiStore'
import { PanelRightIcon, SparkleIcon } from '../components/icons'

export default function AiPanel() {
  const open = useUiStore((state) => state.aiPanelOpen)
  const width = useUiStore((state) => state.aiPanelWidth)
  const toggle = useUiStore((state) => state.toggleAiPanel)
  const setWidth = useUiStore((state) => state.setAiPanelWidth)

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
    setWidth(window.innerWidth - event.clientX)
  }

  const handlePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  if (!open) {
    return (
      <aside
        aria-label="AI Assistant 패널"
        className="flex w-10 shrink-0 flex-col items-center gap-3 border-l border-line bg-surface-1 py-2"
      >
        <button
          type="button"
          aria-label="AI 패널 펼치기"
          aria-expanded={false}
          onClick={toggle}
          className="rounded-md p-1.5 text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
        >
          <PanelRightIcon />
        </button>
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-faint [writing-mode:vertical-rl]">
          AI Assistant
        </span>
      </aside>
    )
  }

  return (
    <>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="AI 패널 너비 조절"
        className="w-[3px] shrink-0 cursor-col-resize touch-none bg-line transition-colors hover:bg-accent/70 active:bg-accent"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
      />
      <aside
        aria-label="AI Assistant 패널"
        style={{ width }}
        className="flex shrink-0 flex-col bg-surface-1"
      >
        <header className="flex h-12 shrink-0 items-center justify-between border-b border-line pl-4 pr-2">
          <div className="flex items-center gap-2">
            <SparkleIcon className="text-accent" />
            <span className="font-medium text-ink">AI Assistant</span>
          </div>
          <button
            type="button"
            aria-label="AI 패널 접기"
            aria-expanded={true}
            onClick={toggle}
            className="rounded-md p-1.5 text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
          >
            <PanelRightIcon />
          </button>
        </header>

        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <span className="rounded-full border border-line-strong px-2.5 py-0.5 font-mono text-[11px] tracking-wide text-ink-muted">
            Phase 3
          </span>
          <p className="font-medium text-ink">AI Assistant — Phase 3에서 활성화됩니다</p>
          <p className="max-w-60 text-[12px] leading-relaxed text-ink-muted">
            현재 컨텍스트 기반 질문과 Claim·Evidence 응답이 이곳에 제공될 예정입니다.
          </p>
        </div>

        <div className="shrink-0 border-t border-line p-3">
          <div className="flex gap-2">
            <input
              type="text"
              disabled
              aria-label="AI 질문 입력"
              placeholder="질문 입력… (Phase 3)"
              className="min-w-0 flex-1 cursor-not-allowed rounded-md border border-line bg-surface-2 px-3 py-1.5 text-ink placeholder:text-ink-faint disabled:opacity-60"
            />
            <button
              type="button"
              disabled
              className="cursor-not-allowed rounded-md border border-line-strong bg-surface-3 px-3 py-1.5 text-ink-muted disabled:opacity-60"
            >
              전송
            </button>
          </div>
        </div>
      </aside>
    </>
  )
}
