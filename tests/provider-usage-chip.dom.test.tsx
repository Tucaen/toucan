import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { ProviderUsageChip } from '../src/renderer/src/ProviderUsageChip'
import type { ProviderUsageView } from '../src/renderer/src/use-provider-rate-limits'

/**
 * The header's account-usage surface. It reports a provider's plan windows and is the button that
 * refreshes them, so what it has to get right is saying something when a refresh lands: the numbers
 * themselves rarely move between two clicks, and a chip that answers a click by looking identical
 * is a chip the user reasonably reads as broken.
 */

const READ_AT = new Date('2026-09-11T14:32:00').getTime()

function view(overrides: Partial<ProviderUsageView> = {}): ProviderUsageView {
  return {
    status: { fiveHour: { usedPercent: 2 }, weekly: { usedPercent: 59 } },
    readAt: READ_AT,
    stale: false,
    refreshing: false,
    ...overrides
  }
}

function renderChip(entry: ProviderUsageView, onRefresh = vi.fn()) {
  const result = render(<ProviderUsageChip provider="claude" entry={entry} onRefresh={onRefresh} />)
  return {
    onRefresh,
    rerender: (next: ProviderUsageView) =>
      result.rerender(<ProviderUsageChip provider="claude" entry={next} onRefresh={onRefresh} />)
  }
}

describe('the provider usage chip', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  test('refreshes its own provider when clicked', () => {
    const { onRefresh } = renderChip(view())

    fireEvent.click(screen.getByRole('button', { name: /Claude/ }))

    expect(onRefresh).toHaveBeenCalledExactlyOnceWith('claude')
  })

  test('dates the reading it is showing', () => {
    renderChip(view())

    expect(screen.getByRole('button', { name: /Claude/ })).toHaveAttribute('title', expect.stringContaining('Updated'))
  })

  test('a refresh in flight says so and cannot be started twice', () => {
    const { onRefresh } = renderChip(view({ refreshing: true }))
    const chip = screen.getByRole('button', { name: /Claude/ })

    expect(chip).toBeDisabled()
    expect(chip).toHaveAttribute('title', expect.stringContaining('Refreshing'))
    fireEvent.click(chip)
    expect(onRefresh).not.toHaveBeenCalled()
  })

  test('confirms a landed refresh even when the numbers did not change', () => {
    const { rerender } = renderChip(view({ refreshing: true }))
    expect(screen.getByRole('button', { name: /Claude/ })).not.toHaveAttribute('data-refreshed')

    // Same figures, new reading: the cue is the only thing telling the user the click did anything.
    rerender(view({ refreshing: false, readAt: READ_AT + 60_000 }))
    expect(screen.getByRole('button', { name: /Claude/ })).toHaveAttribute('data-refreshed', 'true')

    act(() => vi.advanceTimersByTime(1500))
    expect(screen.getByRole('button', { name: /Claude/ })).not.toHaveAttribute('data-refreshed')
  })

  test('does not confirm a refresh that only fell back to the reading already on screen', () => {
    const { rerender } = renderChip(view({ refreshing: true }))

    rerender(view({ refreshing: false, stale: true }))

    const chip = screen.getByRole('button', { name: /Claude/ })
    expect(chip).not.toHaveAttribute('data-refreshed')
    expect(chip).toHaveAttribute('data-stale', 'true')
    expect(chip).toHaveAttribute('title', expect.stringContaining('Last read failed'))
  })

  test('a second refresh inside the cue window still gets its own confirmation', () => {
    const { rerender } = renderChip(view({ refreshing: true }))
    rerender(view({ refreshing: false, readAt: READ_AT + 60_000 }))
    expect(screen.getByRole('button', { name: /Claude/ })).toHaveAttribute('data-refreshed', 'true')

    // Clicked again before the first cue expired: it has to come down, or the second landing has
    // no state change to show for itself and the click looks ignored.
    rerender(view({ refreshing: true, readAt: READ_AT + 60_000 }))
    expect(screen.getByRole('button', { name: /Claude/ })).not.toHaveAttribute('data-refreshed')

    rerender(view({ refreshing: false, readAt: READ_AT + 120_000 }))
    expect(screen.getByRole('button', { name: /Claude/ })).toHaveAttribute('data-refreshed', 'true')
  })

  test('a reading that turns stale mid-cue drops the confirmation', () => {
    const { rerender } = renderChip(view({ refreshing: true }))
    rerender(view({ refreshing: false, readAt: READ_AT + 60_000 }))
    expect(screen.getByRole('button', { name: /Claude/ })).toHaveAttribute('data-refreshed', 'true')

    rerender(view({ refreshing: false, readAt: READ_AT + 60_000, stale: true }))

    const chip = screen.getByRole('button', { name: /Claude/ })
    expect(chip).not.toHaveAttribute('data-refreshed')
    expect(chip).toHaveAttribute('data-stale', 'true')
  })

  test('the poll does not flash the header', () => {
    const { rerender } = renderChip(view())

    // A poll replaces the reading without the chip ever having been refreshing.
    rerender(view({ readAt: READ_AT + 60_000 }))

    expect(screen.getByRole('button', { name: /Claude/ })).not.toHaveAttribute('data-refreshed')
  })

  test('marks where the reset sits inside a window that reported one', () => {
    vi.setSystemTime(READ_AT)
    const fourHoursOut = READ_AT + 4 * 60 * 60_000
    renderChip(
      view({
        status: {
          // One hour into the 5h window; the weekly window reported no reset moment.
          fiveHour: { usedPercent: 40, resetsAt: fourHoursOut },
          weekly: { usedPercent: 59 },
          // A per-model window has no known span, so it must not guess a marker position.
          models: [{ label: 'Fable', usedPercent: 64, resetsAt: fourHoursOut }]
        }
      })
    )

    const chip = screen.getByRole('button', { name: /Claude/ })
    const markers = chip.querySelectorAll('.usage-window-reset')
    expect(markers).toHaveLength(1)
    // The stylesheet reads the position from this property so it can snap it to a whole pixel.
    expect((markers[0] as HTMLElement).style.getPropertyValue('--usage-reset-left')).toBe('20%')
  })

  test('renders only the windows the provider reported', () => {
    renderChip(view({ status: { weekly: { usedPercent: 76 }, models: [{ label: 'Fable', usedPercent: 64 }] } }))

    const chip = screen.getByRole('button', { name: /Claude/ })
    expect(chip.textContent).toContain('7d')
    expect(chip.textContent).toContain('Fable')
    expect(chip.textContent).not.toContain('5h')
  })
})
