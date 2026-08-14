import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach, vi } from 'vitest'

vi.mock('../lib/monacoSetup', () => ({
  configureMonaco: () => {},
}))

// Node 26의 experimental localStorage 전역(--localstorage-file 미지정 시 undefined)이
// vitest jsdom 환경의 localStorage를 가리므로, 테스트에서는 결정적인 in-memory Storage를 사용한다.
const store = new Map<string, string>()
const localStorageShim: Storage = {
  get length() {
    return store.size
  },
  clear: () => {
    store.clear()
  },
  getItem: (key) => store.get(key) ?? null,
  key: (index) => [...store.keys()][index] ?? null,
  removeItem: (key) => {
    store.delete(key)
  },
  setItem: (key, value) => {
    store.set(key, String(value))
  },
}
Object.defineProperty(globalThis, 'localStorage', {
  value: localStorageShim,
  configurable: true,
  writable: true,
})

// 테스트는 기존 단언(한국어)을 유지하도록 기본 언어를 ko로 고정한다.
// 일부 테스트가 beforeEach에서 window.localStorage.clear()를 호출해 설정을 지우므로,
// clear 직후 항상 ko가 복원되도록 clear를 래핑한다.
const originalClear = localStorageShim.clear.bind(localStorageShim)
localStorageShim.clear = () => {
  originalClear()
  localStorageShim.setItem('code-intelligence.lang', 'ko')
}
localStorageShim.setItem('code-intelligence.lang', 'ko')

afterEach(() => {
  cleanup()
})
