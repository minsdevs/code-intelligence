import { expect, it } from 'vitest'
import { extractTs } from './ts-extractor'

it('keeps large authenticated DTOs bounded on wire while reusing unchanged high-degree modules', () => {
  const names = Array.from({ length: 300 }, (_, index) => `Service${index}`)
  const files = [
    { path: 'providers.ts', content: names.map((name) => `export class ${name} { run() { return 1 } }`).join('\n') },
    { path: 'module.ts', content: `import { Module } from '@nestjs/common'; import { ${names.join(',')} } from './providers'; @Module({providers:[${names.join(',')}]}) export class AppModule {}` },
  ]
  const cold = extractTs(files, { incremental: true })
  expect(cold.cache).toHaveLength(files.length)
  expect(cold.cache!.every((token) => token.length * 2 <= 128 * 1024)).toBe(true)
  const cache = new Map(cold.cache!.map((token) => [JSON.parse(token).path, token]))
  const programs: number[] = []
  const { cache: _cache, ...warm } = extractTs(files.map((file) => ({ ...file, cache: cache.get(file.path) })), {
    incremental: true, onProgram: (program) => programs.push(program.files),
  })
  expect(warm).toEqual(extractTs(files))
  expect(programs).toEqual([])
})
