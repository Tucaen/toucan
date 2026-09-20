import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import { describeProviderUsage } from '../mobile/src/provider-usage'
import type { ProviderUsageReport } from '../src/shared/agent'

/**
 * What the phone's chat list says about the account behind each provider (issue #195). The phone's
 * constraints are not the desktop's: there is no hover, so nothing worth reading may live in a
 * tooltip, and there is no refresh button, so every figure has to date itself.
 */

const NOW = Date.UTC(2026, 0, 2, 12, 0, 0)

function report(overrides: ProviderUsageReport = {}): ProviderUsageReport {
  return {
    claude: {
      status: { fiveHour: { usedPercent: 40, resetsAt: NOW + 90 * 60_000 }, weekly: { usedPercent: 93 } },
      readAt: NOW - 30_000,
      stale: false
    },
    ...overrides
  }
}

describe('the phone reading of account usage', () => {
  test('a provider becomes one card naming itself, its windows in plan order', () => {
    const cards = describeProviderUsage(report(), NOW)
    assert.equal(cards.length, 1)
    assert.equal(cards[0].provider, 'claude')
    assert.equal(cards[0].label, 'Claude')
    assert.deepEqual(
      cards[0].windows.map((window) => window.label),
      ['5h', '7d']
    )
  })

  test('providers are listed in one fixed order, so the row does not reshuffle between polls', () => {
    const both = report({ codex: { status: { weekly: { usedPercent: 5 } }, readAt: NOW, stale: false } })
    assert.deepEqual(
      describeProviderUsage(both, NOW).map((card) => card.provider),
      ['claude', 'codex']
    )
  })

  test('the card takes the level of the window closest to biting, not of the first one listed', () => {
    // 40% is normal and 93% is critical; the card has to read as the worse of the two.
    assert.equal(describeProviderUsage(report(), NOW)[0].level, 'critical')
  })

  test('a provider that has actually refused a request reads as critical whatever it reports', () => {
    const refused = { claude: { status: { fiveHour: { usedPercent: 3 }, rejected: true }, readAt: NOW, stale: false } }
    const [card] = describeProviderUsage(refused, NOW)
    assert.equal(card.rejected, true)
    assert.equal(card.level, 'critical')
  })

  test('a refusal with no window at all is still worth a card: it is the news', () => {
    const [card] = describeProviderUsage({ claude: { status: { rejected: true }, readAt: NOW, stale: false } }, NOW)
    assert.equal(card.rejected, true)
    assert.deepEqual(card.windows, [])
  })

  test('a provider with nothing to report is dropped rather than shown as an empty chip', () => {
    assert.deepEqual(describeProviderUsage({ claude: { status: {}, readAt: NOW, stale: false } }, NOW), [])
    assert.deepEqual(describeProviderUsage({}, NOW), [])
  })

  test('when relief arrives is visible text, because a phone has no tooltip to hide it in', () => {
    const [card] = describeProviderUsage(report(), NOW)
    const [fiveHour, weekly] = card.windows
    assert.ok(fiveHour.resets?.startsWith('1h 30m'), `expected a relative reset, got ${fiveHour.resets}`)
    // A provider that reported no reset moment must not be given a guessed one.
    assert.equal(weekly.resets, undefined)
  })

  test('every card dates its own reading, since nothing here can be refreshed by hand', () => {
    const [fresh] = describeProviderUsage(report(), NOW)
    assert.equal(fresh.stale, false)
    assert.match(fresh.freshness, /^Updated /)

    const [kept] = describeProviderUsage(
      { claude: { status: { weekly: { usedPercent: 10 } }, readAt: NOW - 3_600_000, stale: true } },
      NOW
    )
    assert.equal(kept.stale, true)
    assert.match(kept.freshness, /^Last read failed/)
  })

  test('the percentages a bar may draw are clamped, however the provider overshot', () => {
    const over = { claude: { status: { weekly: { usedPercent: 140 } }, readAt: NOW, stale: false } }
    const [window] = describeProviderUsage(over, NOW)[0].windows
    assert.equal(window.displayPercent, 100)
  })
})
