import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import type { AreaType } from '../api/types'

export const AI_PANEL_MIN_WIDTH = 280
export const AI_PANEL_MAX_WIDTH = 560
export const AI_PANEL_DEFAULT_WIDTH = 340
export const SIDEBAR_WIDTH = 240
export const SIDEBAR_COLLAPSED_WIDTH = 56

export type FocusedNode = {
  id: number
  name: string
  nodeType: string
  filePath: string | null
  lineStart: number | null
}

type UiState = {
  sidebarCollapsed: boolean
  toggleSidebar: () => void
  aiPanelOpen: boolean
  aiPanelWidth: number
  selectedAreas: AreaType[]
  focusedFile: string | null
  focusedNode: FocusedNode | null
  focusedCommitSha: string | null
  focusedFindingId: number | null
  focusedNoteId: number | null
  focusedTaskId: number | null
  pendingIntent: string | null
  toggleAiPanel: () => void
  setAiPanelOpen: (open: boolean) => void
  setAiPanelWidth: (width: number) => void
  setSelectedAreas: (areas: AreaType[]) => void
  setFocusedFile: (file: string | null) => void
  setFocusedNode: (node: FocusedNode | null) => void
  setFocusedCommitSha: (sha: string | null) => void
  setFocusedFindingId: (id: number | null) => void
  setFocusedNoteId: (id: number | null) => void
  setFocusedTaskId: (id: number | null) => void
  setPendingIntent: (intent: string | null) => void
}

const clampWidth = (width: number) =>
  Math.min(AI_PANEL_MAX_WIDTH, Math.max(AI_PANEL_MIN_WIDTH, Math.round(width)))

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      sidebarCollapsed: false,
      toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
      aiPanelOpen: false,
      aiPanelWidth: AI_PANEL_DEFAULT_WIDTH,
      selectedAreas: [],
      focusedFile: null,
      focusedNode: null,
      focusedCommitSha: null,
      focusedFindingId: null,
      focusedNoteId: null,
      focusedTaskId: null,
      pendingIntent: null,
      toggleAiPanel: () => set((state) => ({ aiPanelOpen: !state.aiPanelOpen })),
      setAiPanelOpen: (aiPanelOpen) => set({ aiPanelOpen }),
      setAiPanelWidth: (width) => set({ aiPanelWidth: clampWidth(width) }),
      setSelectedAreas: (selectedAreas) => set({ selectedAreas }),
      setFocusedFile: (focusedFile) => set({ focusedFile }),
      setFocusedNode: (focusedNode) => set({ focusedNode }),
      setFocusedCommitSha: (focusedCommitSha) => set({ focusedCommitSha }),
      setFocusedFindingId: (focusedFindingId) => set({ focusedFindingId }),
      setFocusedNoteId: (focusedNoteId) => set({ focusedNoteId }),
      setFocusedTaskId: (focusedTaskId) => set({ focusedTaskId }),
      setPendingIntent: (pendingIntent) => set({ pendingIntent }),
    }),
    {
      name: 'code-intelligence.ui',
      // Node 26 ships its own experimental localStorage global (masked as undefined in jsdom tests),
      // so reference window.localStorage explicitly for both browser and jsdom.
      storage: createJSONStorage(() => window.localStorage),
      partialize: (state) => ({
        sidebarCollapsed: state.sidebarCollapsed,
        aiPanelOpen: state.aiPanelOpen,
        aiPanelWidth: state.aiPanelWidth,
      }),
    },
  ),
)
