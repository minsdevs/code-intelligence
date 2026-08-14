import { loader } from '@monaco-editor/react'
import * as monaco from 'monaco-editor'

let configured = false

/** Use the npm monaco-editor build instead of the default jsDelivr CDN loader. */
export function configureMonaco(): void {
  if (configured) return
  configured = true
  loader.config({ monaco })
}
