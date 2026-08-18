import { act, render, renderHook, screen, waitFor } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import type { FirstMateApi } from '../src/preload/index.d'
import { QuotaStat, UsageStat } from '../src/renderer/src/AgentUsageStatus'
import { useAgentConversation } from '../src/renderer/src/use-agent-conversation'
import { useFirstMateQuota } from '../src/renderer/src/use-firstmate-quota'
import type { FirstMateQuotaStatus } from '../src/shared/firstmate'
import { createMockAgentApi } from './dom/agent-api-mock'

// Real-DOM companion to firstmate-quota.test.ts: the permanent context-usage/limits display
// (UsageStat/QuotaStat) and the hook plumbing that feeds them (the usage_update event, the quota
// poll cadence) are exercised by actually rendering/running them here. Whether FirstMatePanel and
// ChatNode actually mount UsageStat/QuotaStat with the right props stays a source-text assertion
// in firstmate-quota.test.ts: those components pull in @xyflow/react's NodeResizer and the
// @moonshine-ai/moonshine-wasm voice prototype, which need a ReactFlowProvider/real audio stack
// well beyond this harness. The main-process quotaStatus/quota-axi tests earlier in
// firstmate-quota.test.ts already execute real runtime code and need no change.

describe('UsageStat', () => {
  test('shows a placeholder until usage is known', () => {
    render(<UsageStat usage={null} />)
    expect(screen.getByText('—')).toBeInTheDocument()
  })

  test('shows the token counts and rounded percentage once usage is known', () => {
    render(<UsageStat usage={{ used: 45_000, size: 200_000, cost: '$0.12' }} />)
    expect(screen.getByText('45.0k/200.0k · 23%')).toBeInTheDocument()
    expect(screen.getByText('$0.12')).toBeInTheDocument()
  })

  test('shows only the percentage when compact, without the cost', () => {
    render(<UsageStat usage={{ used: 45_000, size: 200_000, cost: '$0.12' }} compact />)
    expect(screen.getByText('23%')).toBeInTheDocument()
    expect(screen.queryByText('$0.12')).not.toBeInTheDocument()
  })
})

describe('QuotaStat', () => {
  test('shows a neutral dash with no warning marker while quota has not polled yet', () => {
    render(<QuotaStat quota={null} />)
    const stat = screen.getByText('—').closest('.quota-stat')
    expect(stat).toHaveAttribute('data-state', 'loading')
    expect(stat?.querySelector('.quota-stat-warning')).toBeNull()
  })

  test('shows a dash plus a visible warning marker (not just a tooltip) when quota-axi reports no usable windows', () => {
    render(<QuotaStat quota={{ state: 'unavailable', provider: 'claude', message: 'Codex sign-in required' } as FirstMateQuotaStatus} />)
    const stat = screen.getByText('—').closest('.quota-stat')
    expect(stat).toHaveAttribute('data-state', 'unavailable')
    expect(stat).toHaveAttribute('title', 'Codex sign-in required')
    expect(stat?.querySelector('.quota-stat-warning')).not.toBeNull()
  })

  test('shows the session and week percent-remaining windows when ok', () => {
    const quota: FirstMateQuotaStatus = {
      state: 'ok',
      provider: 'claude',
      session: { percentRemaining: 33, resetsAt: '2026-08-18T11:10:00.000Z' },
      week: { percentRemaining: 93, resetsAt: '2026-08-25T03:00:00.000Z' }
    }
    render(<QuotaStat quota={quota} />)
    expect(screen.getByText('33% 5h')).toBeInTheDocument()
    expect(screen.getByText('93% wk')).toBeInTheDocument()
  })

  test('drops the window suffix when compact', () => {
    const quota: FirstMateQuotaStatus = {
      state: 'ok',
      provider: 'claude',
      session: { percentRemaining: 33, resetsAt: '2026-08-18T11:10:00.000Z' }
    }
    render(<QuotaStat quota={quota} compact />)
    expect(screen.getByText('33%')).toBeInTheDocument()
  })
})

test('the usage_update session event is threaded into the conversation hook and exposed to consumers', async () => {
  const { api, emit } = createMockAgentApi()
  window.agentApi = api

  const { result } = renderHook(() => useAgentConversation({
    id: 'session-usage',
    provider: 'claude',
    cwd: '/project',
    enabled: true,
    onSessionId: vi.fn(),
    onPermissionMode: vi.fn(),
    onModel: vi.fn()
  }))

  await waitFor(() => expect(result.current.status).toBe('ready'))
  expect(result.current.usage).toBeNull()

  emit('session-usage', { type: 'usage', used: 12_000, size: 200_000, cost: '$0.03' })

  await waitFor(() => expect(result.current.usage).toEqual({ used: 12_000, size: 200_000, cost: '$0.03' }))
})

test('the quota poll interval stays on an account-wide, minutes-scale cadence rather than spamming quota-axi', async () => {
  vi.useFakeTimers()
  try {
    const quotaStatus = vi.fn<FirstMateApi['quotaStatus']>(async () => ({ state: 'unavailable', provider: 'claude' }))
    window.firstMateApi = { quotaStatus } as unknown as FirstMateApi

    renderHook(() => useFirstMateQuota('claude', true))

    await act(async () => { await Promise.resolve() })
    expect(quotaStatus).toHaveBeenCalledTimes(1)

    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(quotaStatus).toHaveBeenCalledTimes(1)

    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(quotaStatus).toHaveBeenCalledTimes(2)
  } finally {
    vi.useRealTimers()
  }
})
