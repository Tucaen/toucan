import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useProviderRateLimits } from '../src/renderer/src/use-provider-rate-limits'

describe('provider rate-limit coordination', () => {
  const rateLimits = vi.fn()

  beforeEach(() => {
    rateLimits.mockReset()
    window.usageApi = { rateLimits }
  })

  it('loads account usage once for the whole workspace', async () => {
    rateLimits.mockResolvedValue({ codex: { weekly: { usedPercent: 37 } } })

    const { result } = renderHook(() => useProviderRateLimits())

    await waitFor(() => expect(result.current.limits.codex?.weekly?.usedPercent).toBe(37))
    expect(rateLimits).toHaveBeenCalledOnce()
    expect(rateLimits).toHaveBeenCalledWith()
  })

  it('treats a failed initial read as unavailable usage', async () => {
    rateLimits.mockRejectedValue(new Error('offline'))

    const { result } = renderHook(() => useProviderRateLimits())

    await waitFor(() => expect(rateLimits).toHaveBeenCalledOnce())
    expect(result.current.limits).toEqual({})
  })

  it('forces a fresh read when the user asks for a refresh', async () => {
    rateLimits.mockResolvedValueOnce({ codex: { weekly: { usedPercent: 37 } } })
    const { result } = renderHook(() => useProviderRateLimits())
    await waitFor(() => expect(result.current.limits.codex?.weekly?.usedPercent).toBe(37))

    rateLimits.mockResolvedValueOnce({ codex: { weekly: { usedPercent: 61 } } })
    act(() => result.current.refresh())

    expect(rateLimits).toHaveBeenLastCalledWith({ force: true })
    await waitFor(() => expect(result.current.limits.codex?.weekly?.usedPercent).toBe(61))
    expect(result.current.refreshing).toBe(false)
  })

  it('stops reporting a refresh once a failed one settles', async () => {
    rateLimits.mockResolvedValueOnce({ codex: { weekly: { usedPercent: 37 } } })
    const { result } = renderHook(() => useProviderRateLimits())
    await waitFor(() => expect(result.current.limits.codex?.weekly?.usedPercent).toBe(37))

    rateLimits.mockRejectedValueOnce(new Error('offline'))
    act(() => result.current.refresh())

    await waitFor(() => expect(result.current.refreshing).toBe(false))
    // The last good reading survives a failed refresh rather than blanking the header.
    expect(result.current.limits.codex?.weekly?.usedPercent).toBe(37)
  })
})
