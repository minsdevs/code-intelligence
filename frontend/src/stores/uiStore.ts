import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import type { AreaType } from '../api/types'

export const AI_PANEL_MIN_WIDTH = 280
export const AI_PANEL_MAX_WIDTH = 560
export const AI_PANEL_DEFAULT_WIDTH = 340

type UiState = {
  aiPanelOpen: boolean
  aiPanelWidth: number
  selectedAreas: AreaType[]
  toggleAiPanel: () => void
  setAiPanelWidth: (width: number) => void
  setSelectedAreas: (areas: AreaType[]) => void
}

const clampWidth = (width: number) =>
  Math.min(AI_PANEL_MAX_WIDTH, Math.max(AI_PANEL_MIN_WIDTH, Math.round(width)))

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      aiPanelOpen: true,
      aiPanelWidth: AI_PANEL_DEFAULT_WIDTH,
      selectedAreas: [],
      toggleAiPanel: () => set((state) => ({ aiPanelOpen: !state.aiPanelOpen })),
      setAiPanelWidth: (width) => set({ aiPanelWidth: clampWidth(width) }),
      setSelectedAreas: (selectedAreas) => set({ selectedAreas }),
    }),
    {
      name: 'code-intelligence.ui',
      // Node 26이 자체 experimental localStorage 전역을 갖고 있어(jsdom 테스트에서 undefined로 가려짐)
      // 브라우저/jsdom 모두에서 확실한 window.localStorage를 명시한다.
      storage: createJSONStorage(() => window.localStorage),
      partialize: (state) => ({
        aiPanelOpen: state.aiPanelOpen,
        aiPanelWidth: state.aiPanelWidth,
      }),
    },
  ),
)
