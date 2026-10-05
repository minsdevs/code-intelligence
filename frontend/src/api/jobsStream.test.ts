import { afterEach, describe, expect, it, vi } from 'vitest'
import { subscribeJobEvents } from './jobs'

afterEach(() => vi.unstubAllGlobals())

describe('analysis event stream termination', () => {
  it('reconciles normal EOF after an active job update', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      'data: {"id":1,"status":"RUNNING"}\n\n',
      { headers: { 'Content-Type': 'text/event-stream' } },
    )))
    const onJob = vi.fn()
    const onDisconnect = vi.fn()
    const unsubscribe = subscribeJobEvents(1, onJob, onDisconnect)
    await vi.waitFor(() => expect(onDisconnect).toHaveBeenCalledTimes(1))
    expect(onJob).toHaveBeenCalledWith({ id: 1, status: 'RUNNING' })
    unsubscribe()
  })

  it('does not reconnect when a terminal event intentionally aborts the subscription', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      'data: {"id":1,"status":"DONE"}\n\n',
      { headers: { 'Content-Type': 'text/event-stream' } },
    )))
    const onDisconnect = vi.fn()
    const onJob = vi.fn(() => unsubscribe())
    const unsubscribe = subscribeJobEvents(1, onJob, onDisconnect)
    await vi.waitFor(() => expect(onJob).toHaveBeenCalledTimes(1))
    expect(onDisconnect).not.toHaveBeenCalled()
  })
})
