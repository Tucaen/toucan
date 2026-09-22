import type {
  AgentProvider,
  AgentRateLimitStatus,
  AgentRateLimitWindow,
  AgentSessionCost,
  ProviderUsageEntry
} from './agent'

/** The latest `usage_update` a session reported, verbatim; the display maths is below. */
export interface SessionUsageInput {
  /** Tokens currently in context, as the adapter last reported them. */
  used?: number
  /** The model's context window; adapters that cannot determine it omit it. */
  size?: number
  cost?: AgentSessionCost
}

/**
 * Folds one `usage_update` onto what the session already knew. Adapters report these fields
 * independently - Claude sends a cost only once a turn has produced tokens, Codex sends none at
 * all, and either may report tokens before it knows the context window - so an update is a patch,
 * not a replacement: overwriting wholesale would blank a cost or a gauge the reader was already
 * shown, which reads as "it went away" rather than "it was not mentioned this time".
 */
export function mergeSessionUsage(previous: SessionUsageInput | null, update: SessionUsageInput): SessionUsageInput {
  return {
    ...previous,
    ...(update.used !== undefined ? { used: update.used } : {}),
    ...(update.size !== undefined ? { size: update.size } : {}),
    ...(update.cost !== undefined ? { cost: update.cost } : {})
  }
}

/**
 * Every decision behind a usage readout: how full the context window is, what the conversation has
 * cost, and which account window is closest to biting. The readings themselves come from ACP's
 * `usage_update` and `src/main/provider-usage.ts`; deciding what they *mean* happens only here, so
 * every bar and chip is markup and the thresholds have one home.
 *
 * Shared rather than renderer-only because three surfaces show the same windows - the chat node's
 * bar, the desktop header's chips, and the phone, which imports `src/shared` and nothing else of
 * Toucan's. Two surfaces deriving one window separately is how it comes to read `critical` on one
 * device and `warning` on the other, with no way for the reader to tell which lied.
 */

/** Percent of a window consumed, in the three bands the UI colours. */
export type UsageLevel = 'normal' | 'warning' | 'critical'

const WARNING_PERCENT = 75
const CRITICAL_PERCENT = 90

/** @internal exported for tests */
export function usageLevel(percent: number): UsageLevel {
  if (percent >= CRITICAL_PERCENT) return 'critical'
  if (percent >= WARNING_PERCENT) return 'warning'
  return 'normal'
}

/**
 * `toLocaleString` would be shorter but its grouping follows whatever locale the renderer happens
 * to run under, which makes the same tooltip untestable and inconsistent between machines.
 */
function groupDigits(value: number): string {
  return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/**
 * Local wall-clock `HH:MM`. Hand-rolled for the same reason `groupDigits` is: a locale formatter
 * would make one tooltip read `14:05` beside another reading `2:05 PM`, and the same string
 * untestable between machines. `formatResetsAt` builds the same clock off the `Date` it already
 * has for the day and month.
 */
function clockTime(at: number): string {
  const moment = new Date(at)
  return `${pad(moment.getHours())}:${pad(moment.getMinutes())}`
}

/** What any bar or percentage label may show, whatever the provider reported. */
function clampPercent(percent: number): number {
  return Math.round(Math.max(0, Math.min(100, percent)))
}

/**
 * The status bar is the tightest row in the node, so a token count trades precision for width as
 * it grows: a decimal is worth a character below 100k and worth nothing above it.
 * @internal exported for tests
 */
export function formatTokens(tokens: number): string {
  const value = Math.max(0, tokens)
  if (value < 1_000) return String(Math.round(value))
  if (value < 100_000) return `${(value / 1_000).toFixed(1)}k`
  if (value < 1_000_000) return `${Math.round(value / 1_000)}k`
  return `${(value / 1_000_000).toFixed(1)}M`
}

/**
 * How long until a window resets, plus the wall-clock moment it lands on. The relative duration is
 * what the reader plans around and is deliberately coarse, so the clock time carries the precision
 * the duration drops; a reset more than a day out also needs its date to be unambiguous. A past
 * reset reads as "now" rather than as a negative duration.
 * @internal exported for tests
 */
export function formatResetsAt(resetsAt: number, now: number = Date.now()): string {
  const delta = resetsAt - now
  if (delta <= 0) return 'now'
  const minutes = Math.ceil(delta / 60_000)
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  const remainingHours = hours % 24
  const beyondADay = minutes > 24 * 60
  const duration = beyondADay
    ? [
        `${Math.floor(hours / 24)}d`,
        remainingHours > 0 ? `${remainingHours}h` : null,
        remainingMinutes > 0 ? `${remainingMinutes}m` : null
      ]
        .filter((part): part is string => part !== null)
        .join(' ')
    : minutes < 60
      ? `${minutes}m`
      : remainingMinutes > 0
        ? `${hours}h ${remainingMinutes}m`
        : `${hours}h`
  const reset = new Date(resetsAt)
  const clock = `${pad(reset.getHours())}:${pad(reset.getMinutes())}`
  const stamp = beyondADay ? `${pad(reset.getDate())}.${pad(reset.getMonth() + 1)}. - ${clock}` : clock
  return `${duration} | ${stamp}`
}

/**
 * How long each plan-wide window spans. A provider reports only the reset moment, so knowing where
 * "now" sits inside the window takes the window's length. The named slots carry it by definition;
 * a per-model window states its own span in `windowMinutes`, since only its producer knows it.
 */
const FIVE_HOUR_MS = 5 * 60 * 60_000
const SEVEN_DAY_MS = 7 * 24 * 60 * 60_000

export interface RateLimitWindowReadout {
  /** The window name the UI shows: `5h`, `7d`, or a provider's model name such as `Fable`. */
  label: string
  /** Unrounded and unclamped, so comparing two windows never turns on display precision. */
  percent: number
  /**
   * What a bar or a label may show: clamped to 0-100 and rounded. A provider is free to report
   * more than 100% of a window consumed, and every render of it must read as full rather than as
   * a number no bar can draw.
   */
  displayPercent: number
  level: UsageLevel
  /** One line of prose, used both in the header's tooltip and in a node's. */
  text: string
  /**
   * When relief arrives, as its own phrase (`2h 3m | 16:30`) rather than only folded into `text`.
   * The desktop can afford to keep this in a tooltip; a phone cannot hover, and "when does it
   * reset" is the entire reason to check a limit from away from the desk - so that surface renders
   * it as visible text and needs the phrase without the label and percentage in front of it.
   * Absent when the provider reported no reset moment.
   */
  resets?: string
  /**
   * How far through the window "now" sits, 0 at the window's start and 100 at its reset - the
   * position of the reset marker on the bar. Absent when the provider reported no reset moment or
   * did not state the window's span, because a marker placed by guesswork would misreport when
   * relief arrives.
   */
  resetProgressPercent?: number
}

/**
 * One window's readout, shared by every surface that describes a rate limit.
 * @internal exported for tests; production reaches it through `describeRateLimitWindows`.
 */
export function describeRateLimitWindow(
  label: string,
  window: AgentRateLimitWindow,
  now: number = Date.now(),
  windowMs?: number
): RateLimitWindowReadout {
  const percent = window.usedPercent
  const displayPercent = clampPercent(percent)
  const resets = window.resetsAt === undefined ? undefined : formatResetsAt(window.resetsAt, now)
  const resetProgressPercent =
    window.resetsAt !== undefined && windowMs !== undefined && windowMs > 0
      ? clampPercent(((windowMs - (window.resetsAt - now)) / windowMs) * 100)
      : undefined
  return {
    label,
    percent,
    displayPercent,
    level: usageLevel(percent),
    text: `${label}: ${displayPercent}%${resets === undefined ? '' : ` (resets in ${resets})`}`,
    ...(resets === undefined ? {} : { resets }),
    ...(resetProgressPercent === undefined ? {} : { resetProgressPercent })
  }
}

/**
 * Every window a status carries, in display order: the plan-wide 5h and 7d first, then any
 * per-model allowance under the provider's own name. Exported so the header's chip and the node's
 * bar list the same windows in the same order.
 */
export function describeRateLimitWindows(
  status: AgentRateLimitStatus,
  now: number = Date.now()
): RateLimitWindowReadout[] {
  return [
    status.fiveHour ? describeRateLimitWindow('5h', status.fiveHour, now, FIVE_HOUR_MS) : null,
    status.weekly ? describeRateLimitWindow('7d', status.weekly, now, SEVEN_DAY_MS) : null,
    ...(status.models ?? []).map((model) =>
      describeRateLimitWindow(
        model.label,
        model,
        now,
        model.windowMinutes === undefined ? undefined : model.windowMinutes * 60_000
      )
    )
  ].filter((window): window is RateLimitWindowReadout => window !== null)
}

/**
 * The window that will actually stop the next turn, and therefore the one any surface with room
 * for a single figure spends it on. Null only when the status carried no window at all.
 *
 * "Worst" is a rule, not an implementation detail: two reduces written a week apart is how one
 * surface comes to rank by `displayPercent` and the other by `percent`, and then two devices
 * disagree about which plan is the problem. Every surface reaches it through `accountUsageLevel`
 * or `describeSessionUsage`.
 * @internal exported for tests
 */
export function worstRateLimitWindow(windows: readonly RateLimitWindowReadout[]): RateLimitWindowReadout | null {
  return windows.reduce<RateLimitWindowReadout | null>(
    (worst, window) => (worst === null || window.percent > worst.percent ? window : worst),
    null
  )
}

/**
 * What colour a whole account reads as: its worst window, except that a provider which has already
 * *refused* a request is at its limit whatever percentages it goes on reporting.
 */
export function accountUsageLevel(windows: readonly RateLimitWindowReadout[], rejected: boolean): UsageLevel {
  if (rejected) return 'critical'
  const worst = worstRateLimitWindow(windows)
  return worst ? worst.level : 'normal'
}

/**
 * What a provider calls itself wherever its account usage is shown; the `AgentProvider` id is
 * lowercase wiring and never display text. Here rather than beside either chip because the phone
 * and the desktop label the same account, and two tables would be two chances to disagree.
 */
const PROVIDER_LABELS: Record<AgentProvider, string> = {
  claude: 'Claude',
  codex: 'Codex'
}

export function providerUsageLabel(provider: AgentProvider): string {
  return PROVIDER_LABELS[provider] ?? provider
}

/**
 * How the header's chip dates its own reading. Plan utilization barely moves minute to minute, so a
 * successful refresh usually re-renders the identical numbers; without a line saying when they were
 * read, a refresh that worked and a refresh that silently failed are the same pixels.
 */
export function describeUsageFreshness(entry: ProviderUsageEntry): string {
  const clock = clockTime(entry.readAt)
  // Worded about the reading rather than the click: the poll can fail here too, and the host backs
  // off after a failure, so this line outlives the refresh that first raised it.
  return entry.stale ? `Last read failed - showing the reading from ${clock}` : `Updated ${clock}`
}

export interface ContextGauge {
  used: number
  size: number
  /** Clamped to 0-100 and rounded, so a fill width and a percentage read as the same number. */
  percent: number
  level: UsageLevel
  /** The bar's own text, e.g. `48.2k / 200k`. */
  label: string
  title: string
  /** Set once the window is full enough that the agent is about to compact the conversation. */
  warning?: string
}

const CONTEXT_WARNINGS: Record<UsageLevel, string | undefined> = {
  normal: undefined,
  warning: 'Context is filling up - the agent will start compacting soon.',
  critical: 'Context is nearly exhausted - compaction is imminent.'
}

/** A label and the longer form behind it; the shape every non-gauge part of the bar renders. */
export interface UsageLabel {
  label: string
  title: string
}

export interface RateLimitReadout extends UsageLabel {
  /** Clamped and rounded: see `RateLimitWindowReadout.displayPercent`. */
  displayPercent: number
  level: UsageLevel
  /** The surfaced window's reset phrase, for a surface that cannot put it in a tooltip. */
  resets?: string
  rejected: boolean
}

export interface SessionUsageReadout {
  context: ContextGauge | null
  /**
   * The token count on its own, for a session that reported one before it knew its context
   * window. Absent whenever `context` is present, since a gauge already prints the same number.
   */
  tokens: UsageLabel | null
  cost: UsageLabel | null
  limit: RateLimitReadout | null
  /** True when there is nothing worth spending a row of the node on. */
  empty: boolean
}

function describeContext(usage: SessionUsageInput): ContextGauge | null {
  const { used, size } = usage
  // A missing or nonsensical window makes a fraction meaningless, and a raw token count without
  // one is not what the reader asked for, so the gauge stays absent rather than guessing a size.
  if (typeof used !== 'number' || typeof size !== 'number' || size <= 0) return null
  const percent = clampPercent((used / size) * 100)
  const level = usageLevel(percent)
  const warning = CONTEXT_WARNINGS[level]
  return {
    used,
    size,
    percent,
    level,
    label: `${formatTokens(used)} / ${formatTokens(size)}`,
    title: `Context: ${groupDigits(used)} of ${groupDigits(size)} tokens (${percent}%)`,
    ...(warning ? { warning } : {})
  }
}

/**
 * The spec asks for "context used against the model's window, and session cost or token count":
 * an adapter that reports tokens before it knows the window still has something to say, and a
 * count with no denominator is it.
 */
function describeTokens(usage: SessionUsageInput): UsageLabel | null {
  if (typeof usage.used !== 'number') return null
  return {
    label: `${formatTokens(usage.used)} tokens`,
    title: `${groupDigits(usage.used)} tokens in context; this session has not reported its context window.`
  }
}

function describeCost(cost: SessionUsageInput['cost']): UsageLabel | null {
  if (!cost || typeof cost.amount !== 'number' || !Number.isFinite(cost.amount)) return null
  const amount = Math.max(0, cost.amount)
  // A metered turn whose cost rounds to zero must not read as a free one.
  const tooSmall = amount > 0 && amount < 0.005
  const label =
    cost.currency === 'USD'
      ? tooSmall
        ? '<$0.01'
        : `$${amount.toFixed(2)}`
      : tooSmall
        ? `<0.01 ${cost.currency}`
        : `${amount.toFixed(2)} ${cost.currency}`
  return { label, title: `Session cost so far: ${label}` }
}

function describeLimit(status: AgentRateLimitStatus | null | undefined, now: number): RateLimitReadout | null {
  if (!status) return null
  const windows = describeRateLimitWindows(status, now)
  if (windows.length === 0) return null

  // The window closest to exhaustion is the one that will actually stop the next turn, so that is
  // the one the bar spends its room on; the rest still reach the tooltip.
  const worst = worstRateLimitWindow(windows)
  if (!worst) return null
  const rejected = status.rejected === true
  return {
    label: worst.label,
    displayPercent: worst.displayPercent,
    level: accountUsageLevel(windows, rejected),
    title: ['Account usage', ...windows.map((window) => window.text), rejected ? 'Limit reached' : null]
      .filter((line): line is string => line !== null)
      .join('\n'),
    // Carried out of the tooltip for the phone, which has no hover: when this window resets is the
    // one thing a reader stuck behind it actually needs, and `title` is invisible on a touchscreen.
    ...(worst.resets === undefined ? {} : { resets: worst.resets }),
    rejected
  }
}

export function describeSessionUsage(input: {
  usage?: SessionUsageInput | null
  rateLimits?: AgentRateLimitStatus | null
  now?: number
}): SessionUsageReadout {
  const usage = input.usage ?? {}
  const context = describeContext(usage)
  const tokens = context ? null : describeTokens(usage)
  const cost = describeCost(usage.cost)
  const limit = describeLimit(input.rateLimits, input.now ?? Date.now())
  return { context, tokens, cost, limit, empty: !context && !tokens && !cost && !limit }
}
