import { en, ko, type Lang } from './translations'

export const LANGS: { id: Lang; labelEn: string; labelNative: string }[] = [
  { id: 'en', labelEn: 'English', labelNative: 'English' },
  { id: 'ko', labelEn: '한국어', labelNative: '한국어' },
]

const STORAGE_KEY = 'code-intelligence.lang'
export const DEFAULT_LANG: Lang = 'en'

const dicts: Record<Lang, Record<string, string>> = { en, ko }

export function readStoredLang(): Lang {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw === 'en' || raw === 'ko') return raw
  } catch {
    // ignore storage errors
  }
  return DEFAULT_LANG
}

export function storeLang(lang: Lang): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, lang)
  } catch {
    // ignore storage errors
  }
}

export function translate(lang: Lang, key: string): string {
  return dicts[lang][key] ?? dicts.en[key] ?? key
}

/** Non-hook accessor for utility functions (reads the stored language). */
export function tt(key: string): string {
  return translate(readStoredLang(), key)
}
