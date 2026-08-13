import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

export const AI_PANEL_MIN_WIDTH = 280
export const AI_PANEL_MAX_WIDTH = 560
export const AI_PANEL_DEFAULT_WIDTH = 340

type UiState = {
  aiPanelOpen: boolean
  aiPanelWidth: number
  toggleAiPanel: () => void
  setAiPanelWidth: (width: number) => void
}

const clampWidth = (width: number) =>
  Math.min(AI_PANEL_MAX_WIDTH, Math.max(AI_PANEL_MIN_WIDTH, Math.round(width)))

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      aiPanelOpen: true,
      aiPanelWidth: AI_PANEL_DEFAULT_WIDTH,
      toggleAiPanel: () => set((state) => ({ aiPanelOpen: !state.aiPanelOpen })),
      setAiPanelWidth: (width) => set({ aiPanelWidth: clampWidth(width) }),
    }),
    {
      name: 'code-intelligence.ui',
      // Node 26이 자체 experimental localStorage 전역을 갖고 있어(jsdom 테스트에서 undefined로 가려짐)
      // 브라우저/jsdom 모두에서 확실한 window.localStorage를 명시한다.
      storage: createJSONStorage(() => window.localStorage),
    },
  ),
)
