import { loader } from '@monaco-editor/react'
import * as monaco from 'monaco-editor'
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker'
import JsonWorker from 'monaco-editor/language/json/json.worker.js?worker'
import CssWorker from 'monaco-editor/language/css/css.worker.js?worker'
import HtmlWorker from 'monaco-editor/language/html/html.worker.js?worker'
import TypeScriptWorker from 'monaco-editor/language/typescript/ts.worker.js?worker'
import { MONACO_THEME, monacoThemeData } from './monacoTheme'

let configured = false

/** Use the npm monaco-editor build instead of the default jsDelivr CDN loader. */
export function configureMonaco(): void {
  if (configured) return
  configured = true
  // Bundle workers with Vite as local assets. Monaco's fallback ESM URLs cannot resolve
  // relative imports from its generated blob URL in the packaged desktop UI.
  globalThis.MonacoEnvironment = {
    getWorker(_workerId, label) {
      if (label === 'json') return new JsonWorker()
      if (label === 'css' || label === 'scss' || label === 'less') return new CssWorker()
      if (label === 'html' || label === 'handlebars' || label === 'razor') return new HtmlWorker()
      if (label === 'typescript' || label === 'javascript') return new TypeScriptWorker()
      return new EditorWorker()
    },
  }
  monaco.editor.defineTheme(MONACO_THEME, monacoThemeData)
  loader.config({ monaco })
}
