import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mergePolledUsage, useProviderRateLimits } from '../src/renderer/src/use-provider-rate-limits'

/** The host dates every reading it returns; these tests only care that the hook carries it through. */
function entry(usedPercent: number, overrides: { readAt?: number; stale?: boolean } = {}) {
  return {
    status: { weekly: { usedPercent } },
    readAt: overrides.readAt ?? 1_000,
    stale: overrides.stale ?? false
  }
}

describe('provider rate-limit coordination', () => {
  const rateLimits = vi.fn()

  beforeEach(() => {
    rateLimits.mockReset()
    window.usageApi = { rateLimits }
  })

  it('loads account usage once for the whole workspace', async () => {
    rateLimits.mockResolvedValue({ codex: entry(37) })

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
    expect(result.current.providers).toEqual({})
  })

  it('forces a fresh read of only the provider the user clicked', async () => {
    rateLimits.mockResolvedValueOnce({ claude: entry(12), codex: entry(37) })
    const { result } = renderHook(() => useProviderRateLimits())
    await waitFor(() => expect(result.current.limits.codex?.weekly?.usedPercent).toBe(37))

    rateLimits.mockResolvedValueOnce({ codex: entry(61, { readAt: 2_000 }) })
    act(() => result.current.refresh('codex'))

    expect(rateLimits).toHaveBeenLastCalledWith({ force: true, provider: 'codex' })
    await waitFor(() => expect(result.current.limits.codex?.weekly?.usedPercent).toBe(61))
    expect(result.current.providers.codex?.readAt).toBe(2_000)
    expect(result.current.providers.codex?.refreshing).toBe(false)
    // The provider that was not clicked keeps its own reading untouched.
    expect(result.current.limits.claude?.weekly?.usedPercent).toBe(12)
  })

  it('reports a refresh only on the provider being refreshed', async () => {
    rateLimits.mockResolvedValueOnce({ claude: entry(12), codex: entry(37) })
    const { result } = renderHook(() => useProviderRateLimits())
    await waitFor(() => expect(result.current.providers.codex).toBeDefined())

    let settle = (_value: unknown): void => {}
    rateLimits.mockReturnValueOnce(
      new Promise((resolve) => {
        settle = resolve
      })
    )
    act(() => result.current.refresh('codex'))

    expect(result.current.providers.codex?.refreshing).toBe(true)
    // A slow or missing CLI on one provider must not disable the other provider's chip.
    expect(result.current.providers.claude?.refreshing).toBe(false)

    await act(async () => {
      settle({ codex: entry(37, { readAt: 2_000 }) })
    })
    expect(result.current.providers.codex?.refreshing).toBe(false)
  })

  it('marks the kept reading stale when a refresh never gets an answer', async () => {
    rateLimits.mockResolvedValueOnce({ codex: entry(37) })
    const { result } = renderHook(() => useProviderRateLimits())
    await waitFor(() => expect(result.current.limits.codex?.weekly?.usedPercent).toBe(37))

    rateLimits.mockRejectedValueOnce(new Error('offline'))
    act(() => result.current.refresh('codex'))

    await waitFor(() => expect(result.current.providers.codex?.refreshing).toBe(false))
    // The last good reading survives a failed refresh rather than blanking the header, but it is
    // no longer allowed to pass for a current one.
    expect(result.current.limits.codex?.weekly?.usedPercent).toBe(37)
    expect(result.current.providers.codex?.stale).toBe(true)
    expect(result.current.providers.codex?.readAt).toBe(1_000)
  })

  it('carries a stale marking made by the host through to the chip', async () => {
    rateLimits.mockResolvedValueOnce({ codex: entry(37) })
    const { result } = renderHook(() => useProviderRateLimits())
    await waitFor(() => expect(result.current.providers.codex).toBeDefined())

    rateLimits.mockResolvedValueOnce({ codex: entry(37, { stale: true }) })
    act(() => result.current.refresh('codex'))

    await waitFor(() => expect(result.current.providers.codex?.stale).toBe(true))
  })

  it('drops a provider that no longer reports anything', async () => {
    rateLimits.mockResolvedValueOnce({ claude: entry(12), codex: entry(37) })
    const { result } = renderHook(() => useProviderRateLimits())
    await waitFor(() => expect(result.current.providers.codex).toBeDefined())

    rateLimits.mockResolvedValueOnce({})
    act(() => result.current.refresh('codex'))

    await waitFor(() => expect(result.current.providers.codex).toBeUndefined())
    expect(result.current.limits.codex).toBeUndefined()
    expect(result.current.providers.claude).toBeDefined()
  })
})

/**
 * The poll is served from the host's cache, so it can answer with a reading a forced refresh has
 * already overtaken. These are the orderings that are hard to provoke against a real host.
 */
describe('folding a poll into what is already on screen', () => {
  const older = { status: { weekly: { usedPercent: 30 } }, readAt: 1_000, stale: false }
  const newer = { status: { weekly: { usedPercent: 44 } }, readAt: 2_000, stale: false }

  it('takes a reading the poll found newer than the one on screen', () => {
    expect(mergePolledUsage({ codex: older }, { codex: newer })).toEqual({ codex: newer })
  })

  it('does not walk a provider backwards to a reading the refresh already overtook', () => {
    expect(mergePolledUsage({ codex: newer }, { codex: older })).toEqual({ codex: newer })
  })

  it('keeps a failure marked until a genuinely newer reading arrives', () => {
    const failed = { ...older, stale: true }
    // A cache hit is not evidence the provider was reachable, so it cannot clear the marking.
    expect(mergePolledUsage({ codex: failed }, { codex: older })).toEqual({ codex: failed })
    expect(mergePolledUsage({ codex: failed }, { codex: newer })).toEqual({ codex: newer })
  })

  it('drops a provider the poll no longer reports and adds one it just found', () => {
    expect(mergePolledUsage({ codex: older }, { claude: newer })).toEqual({ claude: newer })
  })
})
