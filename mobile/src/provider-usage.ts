import type { AgentProvider, ProviderUsageReport } from '../../src/shared/agent'
import {
  accountUsageLevel,
  describeRateLimitWindows,
  describeUsageFreshness,
  providerUsageLabel,
  type RateLimitWindowReadout,
  type UsageLevel
} from '../../src/shared/session-usage'

/**
 * What the chat list says about the account behind each provider (issue #195). Pure, like every
 * other decision module here: the screen renders these cards and decides nothing itself.
 *
 * The maths is not this file's. Thresholds, clamping, window order and wording all come from
 * `src/shared/session-usage.ts`, the same module the desktop's header chip and chat-node bar read -
 * which is the point of the move: a reader who checks the phone *because* they are away from the
 * desk has no way to tell which surface is lying if the two derive `critical` differently.
 *
 * What is decided here is what the phone's constraints change:
 *
 * - **Nothing worth reading may live in a tooltip.** The desktop keeps each window's reset moment
 *   in the chip's `title`; a phone has no hover, and "when does it reset" is the entire reason to
 *   check a limit from away from the desk - so every window carries its reset phrase out for the
 *   view to render as text.
 * - **Every card dates itself.** The desktop can afford an undated reading because a click
 *   refreshes it; the phone deliberately has no refresh (a forced read boots a provider CLI on
 *   someone's desktop), so the only thing standing between a frozen reading and a believed one is
 *   the line saying when it was taken. The same rule binds the chat screen's account window, which
 *   is why `SessionUsageRow` is handed the whole entry and not just its figures.
 * - **A card with nothing to say is not shown.** A chip naming a provider and no figure is noise
 *   on a screen this size. A refusal is the one exception, because a plan that has started saying
 *   no is the news itself even when it reports no percentage to go with it.
 */

/** One provider's account, as the list screen draws it. */
export interface ProviderUsageCard {
  provider: AgentProvider
  /** What the provider calls itself; shared, so the phone and the desktop label one account alike. */
  label: string
  /** Plan-wide windows first, then any per-model allowance, exactly as the desktop lists them. */
  windows: RateLimitWindowReadout[]
  /** The whole card's colour: the window closest to biting, or `critical` once actually refused. */
  level: UsageLevel
  rejected: boolean
  /** When this reading was taken, or that the last read failed and this is the kept one. */
  freshness: string
  stale: boolean
}

/** Fixed, so a poll that drops and restores a provider never reshuffles the row under a thumb. */
const PROVIDER_ORDER: readonly AgentProvider[] = ['claude', 'codex']

export function describeProviderUsage(report: ProviderUsageReport, now: number = Date.now()): ProviderUsageCard[] {
  const cards: ProviderUsageCard[] = []
  for (const provider of PROVIDER_ORDER) {
    const entry = report[provider]
    if (!entry) continue
    const windows = describeRateLimitWindows(entry.status, now)
    const rejected = entry.status.rejected === true
    if (windows.length === 0 && !rejected) continue
    cards.push({
      provider,
      label: providerUsageLabel(provider),
      windows,
      // Which window decides the card's colour is the shared rule, not this file's: the desktop's
      // bar picks the figure it shows the same way, and two reduces written apart is how one
      // surface comes to rank by percent and the other by the rounded percent.
      level: accountUsageLevel(windows, rejected),
      rejected,
      freshness: describeUsageFreshness(entry),
      stale: entry.stale
    })
  }
  return cards
}
