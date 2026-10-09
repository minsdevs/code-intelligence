import { describe, expect, it } from 'vitest'
import { extract } from './tree'
import { parseAnalyzeRequest, parseLocalPaths } from './request'
import type { AnalyzeFile, AnalyzeResponse } from './types'

const files: AnalyzeFile[] = [
  { path: 'api.py', content: 'from model import Model\ndef run():\n    return Model()\n', cache: '' },
  { path: 'model.py', content: 'class Model:\n    pass\n', cache: '' },
  { path: 'main.go', content: 'package main\nfunc Run() int { return 1 }', cache: '' },
  { path: 'src/App.vue', content: '<script>export default { name: "App" }</script>', cache: '' },
  { path: 'src/routes/+page.svelte', content: '<script>let count = 0</script><p>{count}</p>', cache: '' },
]
const graph = ({ cache: _cache, ...result }: AnalyzeResponse) => result

describe('tree incremental extraction', () => {
  it('reuses per-file immutable results and matches full after every language body edit', () => {
    const first = extract(files)
    expect(first.cache).toHaveLength(files.length)
    const cache = new Map(first.cache!.map((entry) => [JSON.parse(entry).path, entry]))
    for (const changed of files) {
      const next = files.map((file) => ({ ...file, content: file.path === changed.path ? file.content.replace(/1|pass|count|App|Model/, 'other') : file.content, cache: cache.get(file.path) }))
      const reused: string[] = []
      const result = extract(next, next.map((file) => file.path), (path) => reused.push(path))
      expect(reused).not.toContain(changed.path)
      expect(reused).toHaveLength(files.length - 1)
      expect(graph(result)).toEqual(graph(extract(next.map(({ cache: _cache, ...file }) => file))))
    }
  })

  it('uses complete local paths across request batches and invalidates resolution on add/delete/rename', () => {
    const first = extract(files)
    const cache = new Map(first.cache!.map((entry) => [JSON.parse(entry).path, entry]))
    const api = { ...files[0], cache: cache.get('api.py') }
    for (const paths of [['api.py', 'model.py'], ['api.py'], ['api.py', 'renamed.py']]) {
      const request = { files: [api], localPaths: paths, cacheKey: 'a'.repeat(64) }
      const result = extract(parseAnalyzeRequest(request), parseLocalPaths(request), undefined, request.cacheKey)
      expect(graph(result)).toEqual(graph(extract([{ ...api, cache: undefined }], paths)))
      expect(result.imports.some((entry) => entry.toPath === 'model.py')).toBe(paths.includes('model.py'))
    }
  })

  it('treats malformed cache as a miss and preserves recovered syntax outcomes', () => {
    const input = [{ path: 'bad.py', content: 'def broken(:\n pass', cache: 'invalid' }]
    expect(graph(extract(input))).toEqual(graph(extract(input.map(({ cache: _cache, ...file }) => file))))
  })
})
