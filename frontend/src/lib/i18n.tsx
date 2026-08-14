/* eslint-disable react-refresh/only-export-components -- provider + its hooks are co-located by design */
import { createContext, useContext, useState, type ReactNode } from 'react'
import type { Lang } from './translations'
import { translate, readStoredLang, storeLang } from './i18n-core'

type I18nContextValue = {
  lang: Lang
  setLang: (lang: Lang) => void
  t: (key: string) => string
}

const fallbackContext: I18nContextValue = {
  lang: readStoredLang(),
  setLang: (lang) => storeLang(lang),
  t: (key) => translate(readStoredLang(), key),
}

const I18nContext = createContext<I18nContextValue>(fallbackContext)

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(readStoredLang)
  const setLang = (next: Lang) => {
    setLangState(next)
    storeLang(next)
  }
  const t = (key: string) => translate(lang, key)
  return <I18nContext.Provider value={{ lang, setLang, t }}>{children}</I18nContext.Provider>
}

export function useI18n(): I18nContextValue {
  return useContext(I18nContext)
}

export function useT(): (key: string) => string {
  return useI18n().t
}
