/**
 * The two ways Toucan says "when", and the only two.
 *
 * `formatRelativeTime` reads an *instant* - a transcript's `updatedAt` - and answers in the
 * coarsest unit that still means something, falling back to a locale date once a count of days
 * stops being easier to read than the date itself. `describeCalendarDate` reads a *calendar day*
 * (`YYYY-MM-DD`), which is what the brain-dump library and the ticket board record: those surfaces
 * store days, not instants, so "today" there means the same calendar day rather than 24 hours.
 *
 * Both live here because three copies of these rules had already drifted apart in wording while
 * agreeing on the arithmetic (#230). A surface that wants a different vocabulary should say so out
 * loud by adding a function here, not by keeping its own private near-copy.
 */

const DAY_MS = 86_400_000

/**
 * Whole days from one `YYYY-MM-DD` to another, or null when either is not a date. Parsed as UTC
 * midnight on both ends so a local timezone cannot turn a day boundary into an off-by-one.
 */
export function calendarDaysBetween(from: string, to: string): number | null {
  const start = Date.parse(`${from}T00:00:00Z`)
  const end = Date.parse(`${to}T00:00:00Z`)
  if (Number.isNaN(start) || Number.isNaN(end)) return null
  return Math.round((end - start) / DAY_MS)
}

/**
 * An ISO instant relative to `now`. Beyond a month the locale date says more than a widening count
 * of days; an unparseable value is `unknown` rather than a silent `NaN`.
 */
export function formatRelativeTime(iso: string, now: number = Date.now()): string {
  const at = Date.parse(iso)
  if (!Number.isFinite(at)) return 'unknown'
  const seconds = Math.round((now - at) / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days}d ago`
  return new Date(at).toLocaleDateString()
}

/**
 * A calendar date relative to `today`, both `YYYY-MM-DD`. Beyond a week the exact date says more
 * than a widening count of days, and a value that is not a date is returned as it was written -
 * a card's own words are better than an invented "unknown".
 */
export function describeCalendarDate(date: string, today: string): string {
  if (date === today) return 'today'
  const elapsed = calendarDaysBetween(date, today)
  if (elapsed === null) return date
  if (elapsed === 1) return 'yesterday'
  if (elapsed > 1 && elapsed < 7) return `${elapsed} days ago`
  return date
}
