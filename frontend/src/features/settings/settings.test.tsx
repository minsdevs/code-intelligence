import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { routes } from '../../app/router'
import { AI_PANEL_DEFAULT_WIDTH, useUiStore } from '../../stores/uiStore'

let modelRequests = 0

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

beforeEach(() => {
  window.localStorage.clear()
  modelRequests = 0
  useUiStore.setState({ aiPanelOpen: false, aiPanelWidth: AI_PANEL_DEFAULT_WIDTH, selectedAreas: [] })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const path = new URL(href, 'http://localhost').pathname
      if (path === '/api/ai/status') return jsonResponse({ configured: true, provider: 'openai' })
      if (path === '/api/ai/settings') {
        return jsonResponse({ provider: 'openai', model: 'gpt-4o-mini', keyMasked: 'sk-a…abcd', keySet: true })
      }
      if (path === '/api/ai/settings/models') {
        modelRequests += 1
        if (modelRequests === 1) return jsonResponse({ title: 'Unavailable' }, 503)
        return jsonResponse([
          {
            id: 'gpt-4o-mini',
            supportsStreaming: false,
            supportsTools: false,
            supportsReasoning: false,
            supportsVision: false,
            maxContextTokens: 8000,
          },
        ])
      }
      return jsonResponse({ title: 'Not Found' }, 404)
    }),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('SettingsPage', () => {
  it('shows provider status and the stored key', async () => {
    const router = createMemoryRouter(routes, { initialEntries: ['/settings'] })
    render(<RouterProvider router={router} />)
    expect(await screen.findByText('사용 가능')).toBeInTheDocument()
    expect(screen.getAllByText('openai').length).toBeGreaterThan(0)
    expect(await screen.findByText('sk-a…abcd')).toBeInTheDocument()
  })

  it('offers an API key field and a save button', async () => {
    const router = createMemoryRouter(routes, { initialEntries: ['/settings'] })
    render(<RouterProvider router={router} />)
    expect(await screen.findByLabelText('API 키')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '키 저장' })).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: '키 제거' })).toBeInTheDocument()
  })

  it('retries a failed model list request', async () => {
    const router = createMemoryRouter(routes, { initialEntries: ['/settings'] })
    render(<RouterProvider router={router} />)

    expect(await screen.findByRole('alert')).toHaveTextContent('Unavailable')
    fireEvent.click(screen.getByRole('button', { name: '모델 목록 다시 시도' }))

    await waitFor(() => expect(screen.getByRole('combobox', { name: '채팅 모델' })).toBeEnabled())
    expect(screen.getByRole('option', { name: 'gpt-4o-mini' })).toBeInTheDocument()
  })
})
