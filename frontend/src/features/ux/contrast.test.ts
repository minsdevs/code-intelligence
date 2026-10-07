import { describe, expect, it } from 'vitest'
import { MONACO_THEME, monacoThemeData } from '../../lib/monacoTheme'

// G-UX A10: text contrast must reach WCAG 2.1 AA (4.5:1 for normal text). The packaged pilot
// measured computed colours; this test checks the same rule at the source: every text colour
// token on every surface it can sit on, every text/background pair written in one class list,
// no Tailwind palette text colour outside the design tokens, and the Monaco editor theme.

const NORMAL_TEXT = 4.5

const sources = import.meta.glob<string>(['../../**/*.{ts,tsx}', '!../../**/*.test.{ts,tsx}'], {
  query: '?raw',
  import: 'default',
  eager: true,
})

// Vitest replaces CSS imports (also `?raw`) with an empty string, so the stylesheet is read
// from disk. The specifier is a variable because the app tsconfig carries no Node types.
const fsModule = 'node:fs'
const { readFileSync } = (await import(/* @vite-ignore */ fsModule)) as {
  readFileSync: (path: string, encoding: 'utf8') => string
}
const { dirname } = import.meta as ImportMeta & { dirname: string }
const stylesheet = readFileSync(`${dirname}/../../index.css`, 'utf8')

const tokens = new Map<string, string>()
for (const match of stylesheet.matchAll(/--color-([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) {
  tokens.set(match[1], match[2].toLowerCase())
}

type Rgb = [number, number, number]

function rgb(hex: string): Rgb {
  const value = hex.replace('#', '')
  return [0, 2, 4].map((offset) => parseInt(value.slice(offset, offset + 2), 16)) as Rgb
}

function luminance([r, g, b]: Rgb): number {
  const [lr, lg, lb] = [r, g, b].map((channel) => {
    const c = channel / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb
}

function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

function over(top: Rgb, alpha: number, bottom: Rgb): Rgb {
  return top.map((channel, index) => channel * alpha + bottom[index] * (1 - alpha)) as Rgb
}

const SURFACES = ['surface-0', 'surface-1', 'surface-2', 'surface-3']
const TEXT_TOKENS = ['ink', 'ink-muted', 'ink-faint', 'accent', 'ok', 'warn', 'danger']
const NON_COLOUR_TEXT = new Set([
  'xs', 'sm', 'base', 'lg', 'xl', '2xl', '3xl', '4xl', 'left', 'center', 'right', 'justify',
  'start', 'end', 'wrap', 'nowrap', 'balance', 'pretty', 'ellipsis', 'clip',
])

function token(name: string): Rgb {
  const value = tokens.get(name)
  if (!value) throw new Error(`Unknown colour token ${name}`)
  return rgb(value)
}

describe('text contrast (WCAG 2.1 AA)', () => {
  it('reads every design token from the stylesheet', () => {
    for (const name of [...SURFACES, ...TEXT_TOKENS]) expect(tokens.has(name), name).toBe(true)
  })

  it('keeps every text token at 4.5:1 or more on every surface', () => {
    const failures: string[] = []
    for (const text of TEXT_TOKENS) {
      for (const surface of SURFACES) {
        const ratio = contrast(token(text), token(surface))
        if (ratio < NORMAL_TEXT) failures.push(`${text} on ${surface}: ${ratio.toFixed(2)}`)
      }
    }
    expect(failures).toEqual([])
  })

  it('uses only design-token text colours in the source', () => {
    const failures: string[] = []
    for (const [path, source] of Object.entries(sources)) {
      for (const match of source.matchAll(/(?<![\w-])text-([a-z]+(?:-[a-z0-9]+)*)(?:\/\d+)?(?![\w[-])/g)) {
        const name = match[1]
        if (NON_COLOUR_TEXT.has(name) || tokens.has(name)) continue
        failures.push(`${path}: text-${name}`)
      }
    }
    expect(failures).toEqual([])
  })

  it('keeps text readable on every background written in the same class list', () => {
    const failures: string[] = []
    for (const [path, source] of Object.entries(sources)) {
      for (const literal of source.matchAll(/(["'`])((?:(?!\1)[^\n])*)\1/g)) {
        const classes = literal[2].split(/\s+/)
        const texts = classes
          .map((name) => /^text-([a-z]+(?:-[a-z0-9]+)*)$/.exec(name)?.[1])
          .filter((name): name is string => name != null && tokens.has(name))
        const backgrounds = classes
          .map((name) => /^bg-([a-z]+(?:-[a-z0-9]+)*)(?:\/(\d+))?$/.exec(name))
          .filter((match): match is RegExpExecArray => match != null && tokens.has(match[1]))
        for (const text of texts) {
          for (const [, background, alpha] of backgrounds) {
            // A translucent background is checked over every surface it can sit on.
            const bases = alpha == null ? [token(background)] : SURFACES.map(token)
            for (const base of bases) {
              const fill = alpha == null ? base : over(token(background), Number(alpha) / 100, base)
              const ratio = contrast(token(text), fill)
              if (ratio < NORMAL_TEXT) {
                failures.push(`${path}: text-${text} on bg-${background}${alpha ? `/${alpha}` : ''} ${ratio.toFixed(2)}`)
              }
            }
          }
        }
      }
    }
    expect(failures).toEqual([])
  })

  it('renders Monaco with a theme whose every token colour reaches 4.5:1', () => {
    const background = rgb(monacoThemeData.colors['editor.background'])
    const failures: string[] = []
    for (const rule of monacoThemeData.rules) {
      if (!rule.foreground) continue
      const ratio = contrast(rgb(rule.foreground), background)
      if (ratio < NORMAL_TEXT) failures.push(`${rule.token || '(default)'} #${rule.foreground}: ${ratio.toFixed(2)}`)
    }
    for (const key of ['editor.foreground', 'editorLineNumber.foreground', 'editorLineNumber.activeForeground']) {
      const ratio = contrast(rgb(monacoThemeData.colors[key]), background)
      if (ratio < NORMAL_TEXT) failures.push(`${key}: ${ratio.toFixed(2)}`)
    }
    expect(failures).toEqual([])
    const editors = Object.entries(sources).filter(([, source]) => /<(Editor|DiffEditor)\b/.test(source))
    expect(editors.length).toBeGreaterThan(0)
    for (const [path, source] of editors) {
      expect(source, path).toContain('theme={MONACO_THEME}')
      expect(source, path).not.toMatch(/theme="vs(-dark)?"/)
    }
    expect(MONACO_THEME).not.toBe('vs-dark')
  })
})
