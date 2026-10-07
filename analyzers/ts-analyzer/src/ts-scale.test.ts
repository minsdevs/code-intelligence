import { describe, expect, it } from 'vitest'
import { extractTs } from './ts-extractor'
import type { AnalyzeFile } from './types'

// A deep relative import chain, like the workload fixture's `u{i}.js` helper chain.
function importChain(length: number): AnalyzeFile[] {
  return Array.from({ length }, (_, i) => ({
    path: `src/chain/c${i}.ts`,
    content: i === length - 1
      ? `export const v${i} = ${i}\n`
      : `import { v${i + 1} } from './c${i + 1}'\nexport const v${i} = v${i + 1} + 1\n`,
  }))
}

describe('TS extraction at the large size class', () => {
  it('resolves a 6,000-file import chain without recursing once per link', () => {
    const result = extractTs(importChain(6000))
    expect(result.imports).toHaveLength(5999)
    expect(result.imports[0]).toEqual(expect.objectContaining({ fromPath: 'src/chain/c0.ts', toPath: 'src/chain/c1.ts' }))
    expect(result.fileOutcomes).toHaveLength(6000)
  }, 120_000)
})
