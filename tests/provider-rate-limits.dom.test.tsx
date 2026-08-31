import { renderHook, waitFor } from '@testing-library/react'
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

    await waitFor(() => expect(result.current.codex?.weekly?.usedPercent).toBe(37))
    expect(rateLimits).toHaveBeenCalledOnce()
  })

  it('treats a failed initial read as unavailable usage', async () => {
    rateLimits.mockRejectedValue(new Error('offline'))

    const { result } = renderHook(() => useProviderRateLimits())

    await waitFor(() => expect(rateLimits).toHaveBeenCalledOnce())
    expect(result.current).toEqual({})
  })
})
