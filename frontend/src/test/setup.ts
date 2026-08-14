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

afterEach(() => {
  cleanup()
})
