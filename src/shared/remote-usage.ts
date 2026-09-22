import {
  AGENT_PROVIDERS,
  type AgentModelRateLimitWindow,
  type AgentRateLimitStatus,
  type AgentRateLimitWindow,
  type ProviderUsageEntry,
  type ProviderUsageReport
} from './agent'
import { isRecord } from './record'

/**
 * `GET /api/usage`: what the account behind each provider has left, for a phone (issue #195).
 *
 * Waiting out a plan limit is something you do *away from the desk*, which is exactly when the
 * phone is the only surface there is - so "how much is left and when does it reset" is arguably
 * worth more here than in the desktop header it started in. Nothing else on this surface answers
 * it: the workspace projection is the canvas's view of what is open, and a session's own
 * `usage_update` covers that conversation, not the account both conversations draw down.
 *
 * The body **is** the report, exactly as `/api/models` is the catalogue: a wrapper object would be
 * a version field nobody reads. Two rules make it safe to expose.
 *
 * It is **read-only and never forced**. The desktop's chip can bypass the host's cache because a
 * click is a person asking; a paired phone cannot, because a forced read *boots a provider CLI
 * process* on someone's desktop.
 *
 * Read that as a bound rather than a promise of no work: the route answers from `ProviderUsage`'s
 * TTL cache, and a request arriving after that TTL has expired does start a real provider read - a
 * desktop nobody is sitting at has nothing else keeping the cache warm. What cannot happen is a
 * client *raising* that rate: however often the phone asks, at most one provider read per TTL
 * follows, and the TTL is the host's. The poll is `PROVIDER_USAGE_POLL_MS` for the same reason -
 * the cadence the desktop's own renderer uses, because a phone has no business asking a home PC
 * harder questions than the PC's own UI does.
 *
 * And it is **parsed, not cast**. Every figure here is one a reader plans around, so a damaged
 * field is dropped rather than rendered: a percentage that is not a number would become a bar of
 * width `NaN%`, and a reset moment that is not a number would become "resets in NaN" - both of
 * which read as information. Damage is contained per provider and per window, because one
 * unreadable entry losing the readable one would blank the very answer the reader opened this for.
 */

/** How often the phone re-reads. The host caches, so this decides display freshness and nothing else. */
export const PROVIDER_USAGE_POLL_MS = 60_000

/** Every provider whose usage may appear on the wire; an unknown key is dropped, never rendered. */
const PROVIDERS = AGENT_PROVIDERS

/**
 * One window, or nothing. `usedPercent` is the window's whole point, so a window without a usable
 * one is not a window with a missing field - it is a window with nothing to say.
 */
function parseWindow(value: unknown): AgentRateLimitWindow | null {
  if (!isRecord(value)) return null
  if (typeof value.usedPercent !== 'number' || !Number.isFinite(value.usedPercent)) return null
  const resetsAt = typeof value.resetsAt === 'number' && Number.isFinite(value.resetsAt) ? value.resetsAt : undefined
  return { usedPercent: value.usedPercent, ...(resetsAt === undefined ? {} : { resetsAt }) }
}

/** A per-model window additionally needs the name it is shown under; there is no fallback label. */
function parseModelWindow(value: unknown): AgentModelRateLimitWindow | null {
  const window = parseWindow(value)
  if (!window || !isRecord(value)) return null
  if (typeof value.label !== 'string' || value.label.length === 0) return null
  const windowMinutes =
    typeof value.windowMinutes === 'number' && Number.isFinite(value.windowMinutes) ? value.windowMinutes : undefined
  return { ...window, label: value.label, ...(windowMinutes === undefined ? {} : { windowMinutes }) }
}

function parseStatus(value: unknown): AgentRateLimitStatus | null {
  if (!isRecord(value)) return null
  const fiveHour = parseWindow(value.fiveHour)
  const weekly = parseWindow(value.weekly)
  const models = Array.isArray(value.models)
    ? value.models.map(parseModelWindow).filter((window): window is AgentModelRateLimitWindow => window !== null)
    : []
  return {
    ...(fiveHour ? { fiveHour } : {}),
    ...(weekly ? { weekly } : {}),
    ...(models.length > 0 ? { models } : {}),
    // Carried only when stated: `rejected: false` and "the provider did not mention it" are the
    // same thing to every reader, and the desktop's own entries omit it rather than deny it.
    ...(typeof value.rejected === 'boolean' ? { rejected: value.rejected } : {})
  }
}

/**
 * One provider's reading. `readAt` and `stale` are not optional decoration: the phone dates what it
 * shows for the same reason the desktop chip does - a kept reading and a fresh one are otherwise
 * identical pixels - so an entry that cannot say when it was read has nothing trustworthy to show.
 */
function parseEntry(value: unknown): ProviderUsageEntry | null {
  if (!isRecord(value)) return null
  if (typeof value.readAt !== 'number' || !Number.isFinite(value.readAt)) return null
  if (typeof value.stale !== 'boolean') return null
  const status = parseStatus(value.status)
  return status === null ? null : { status, readAt: value.readAt, stale: value.stale }
}

/**
 * Reads a usage report off the wire. `null` only when the body is not a report at all; an empty
 * object is an ordinary answer, and the state of a desktop whose providers have not been read yet.
 */
export function parseProviderUsageReport(value: unknown): ProviderUsageReport | null {
  if (!isRecord(value)) return null
  const report: ProviderUsageReport = {}
  for (const provider of PROVIDERS) {
    const entry = parseEntry(value[provider])
    if (entry) report[provider] = entry
  }
  return report
}
