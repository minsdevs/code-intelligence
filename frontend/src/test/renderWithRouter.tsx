import type { ReactNode } from 'react'
import { render } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

/** Standalone routed components keep the same router when a test rerenders them. */
export function renderWithRouter(ui: ReactNode) {
  return render(ui, { wrapper: MemoryRouter })
}
