import { DIFFICULTY_TIERS, type DifficultyTier } from '../shared/orchestration'
import type { JevReachability } from '../shared/orchestration-routing'
import { isRecord } from '../shared/record'
import { errorMessage } from '../shared/text'

/**
 * Jev as the orchestrator's difficulty judge (#36; plan in `docs/plans/orchestrator-mode.md`),
 * evolved from the router experiment's helper (`.agents/skills/route-claude-ticket`). One request
 * carries every ticket to route, with a tier question and a reasoning-depth question per ticket.
 * Jev is shown the tickets and never the models: routing on the pickers' one-line descriptions is
 * exactly what the tier mapping replaces.
 *
 * Main makes the call rather than the CLI, because main owns the mapping and the record - and the
 * key stays here: it is read from main's environment at call time and never enters a reply, a log
 * or the renderer, so every message built from a response is scrubbed of it.
 */

export interface JevTicket {
  id: string
  title: string
  body?: string
  source?: string
}

export interface JevJudgement {
  ticketId: string
  tier: DifficultyTier
  confidence: number
  /** Jev's reasoning-depth score, 0-4. */
  depth: number
}

export type JevRouteResult = { ok: true; judgements: JevJudgement[]; jevModel?: string } | { ok: false; reason: string }

export interface JevRouter {
  judge(tickets: readonly JevTicket[]): Promise<JevRouteResult>
  status(): Promise<JevReachability>
}

export interface JevRouterOptions {
  /** Read at every call, so a key made available to Toucan later is picked up. */
  environment(): Record<string, string | undefined>
  fetch?: typeof fetch
  timeoutMs?: number
}

const API_KEY_ENV = 'TYPESAFE_API_KEY'
const BASE_URL_ENV = 'TYPESAFE_BASE_URL'
const JEV_MODEL = 'jev-latest'
const DEFAULT_TIMEOUT_MS = 20_000
const STATUS_TIMEOUT_MS = 5_000
/** How much of a ticket body Jev is shown: the scope is in the first pages, never in a pasted log. */
const BODY_LIMIT = 6_000

const TIER_CRITERIA: Record<DifficultyTier, string> = {
  low: 'Routine and clearly specified: a mechanical or localized change with explicit acceptance criteria and negligible ambiguity.',
  medium:
    'Ordinary feature or fix work: touches several files or modules and involves some design choices, but the path is clear.',
  high: 'Hard: difficult diagnosis, substantial ambiguity, security-sensitive work, or changes cutting across many modules.',
  frontier:
    'Exceptional: novel or consequential architecture, very high stakes, or reasoning so deep that only the strongest available agent is likely to succeed.'
}

const DEPTH_CRITERIA = [
  'Mechanical execution with an explicit recipe and negligible ambiguity',
  'Localized implementation with clear acceptance criteria',
  'Moderate design choices or interaction among several modules',
  'Difficult debugging, substantial ambiguity, or broad architectural effects',
  'Exceptional complexity, high stakes, or novel architecture'
]

function endpoint(environment: Record<string, string | undefined>): string {
  const configured = environment[BASE_URL_ENV]?.trim().replace(/\/+$/, '')
  if (!configured) return 'https://api.typesafe.ai/v1/systemone'
  return configured.endsWith('/v1/systemone') ? configured : `${configured}/v1/systemone`
}

/** The request, built from the tickets alone. */
function jevRequest(tickets: readonly JevTicket[]): unknown {
  const questions: Record<string, unknown> = {}
  tickets.forEach((_, index) => {
    const ticket = `\`tickets[${index}]\``
    questions[`tier_${index}`] = {
      type: 'choice',
      instructions:
        `How difficult is ticket ${ticket} for a fresh coding agent to implement reliably in one conversation? ` +
        'Judge the work itself: its clarity, how much of the codebase it touches, and how much diagnosis or design it needs.',
      criteria: TIER_CRITERIA
    }
    questions[`depth_${index}`] = {
      type: 'score',
      instructions: `How much deliberate reasoning will successful implementation of ticket ${ticket} require?`,
      criteria: DEPTH_CRITERIA
    }
  })
  return {
    model: JEV_MODEL,
    state: {
      tickets: tickets.map((ticket) => ({
        id: ticket.id,
        title: ticket.title,
        ...(ticket.body ? { description: ticket.body.slice(0, BODY_LIMIT) } : {}),
        ...(ticket.source ? { source: ticket.source } : {})
      }))
    },
    questions
  }
}

const isTier = (value: unknown): value is DifficultyTier => DIFFICULTY_TIERS.includes(value as DifficultyTier)
const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

export function createJevRouter(options: JevRouterOptions): JevRouter {
  const request = options.fetch ?? fetch
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  const scrub = (text: string, key: string): string => (key ? text.split(key).join('[redacted]') : text)

  const judge = async (tickets: readonly JevTicket[]): Promise<JevRouteResult> => {
    const environment = options.environment()
    const key = environment[API_KEY_ENV]?.trim() ?? ''
    if (!key) return { ok: false, reason: `${API_KEY_ENV} is not set for Toucan, so Jev cannot be asked` }
    if (tickets.length === 0) return { ok: true, judgements: [] }
    const url = endpoint(environment)
    const body = JSON.stringify(jevRequest(tickets))
    const call = () =>
      request(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(timeoutMs)
      })
    let response: Response
    try {
      response = await call()
      if (response.status === 429 || response.status === 529) response = await call()
    } catch (error) {
      const name = (error as { name?: string } | null)?.name
      if (name === 'TimeoutError' || name === 'AbortError') {
        return { ok: false, reason: `TypeSafe did not answer within ${Math.round(timeoutMs / 1000)} seconds` }
      }
      return { ok: false, reason: scrub(`the TypeSafe request failed: ${errorMessage(error)}`, key) }
    }
    const text = await response.text().catch(() => '')
    let parsed: unknown
    try {
      parsed = text ? JSON.parse(text) : {}
    } catch {
      parsed = {}
    }
    if (!response.ok) {
      const detail = isRecord(parsed)
        ? isRecord(parsed.error) && typeof parsed.error.message === 'string'
          ? parsed.error.message
          : typeof parsed.message === 'string'
            ? parsed.message
            : undefined
        : undefined
      const reason = `TypeSafe returned HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`
      return { ok: false, reason: scrub(reason, key) }
    }
    const answers = isRecord(parsed) && isRecord(parsed.answers) ? parsed.answers : {}
    const judgements: JevJudgement[] = []
    for (const [index, ticket] of tickets.entries()) {
      const tier = answers[`tier_${index}`]
      const depth = answers[`depth_${index}`]
      if (
        !isRecord(tier) ||
        !isTier(tier.choice) ||
        !isNumber(tier.confidence) ||
        !isRecord(depth) ||
        !isNumber(depth.score)
      ) {
        return { ok: false, reason: `TypeSafe returned an incomplete answer for ticket ${ticket.id}` }
      }
      judgements.push({
        ticketId: ticket.id,
        tier: tier.choice,
        confidence: Math.min(1, Math.max(0, tier.confidence)),
        depth: Math.min(4, Math.max(0, depth.score))
      })
    }
    const jevModel = isRecord(parsed) && typeof parsed.model === 'string' ? parsed.model : undefined
    return { ok: true, judgements, ...(jevModel ? { jevModel } : {}) }
  }

  return {
    async judge(tickets) {
      try {
        return await judge(tickets)
      } catch (error) {
        const key = options.environment()[API_KEY_ENV]?.trim() ?? ''
        return { ok: false, reason: scrub(`Jev could not be asked: ${errorMessage(error)}`, key) }
      }
    },
    async status() {
      const environment = options.environment()
      if (!environment[API_KEY_ENV]?.trim()) return { state: 'no-key' }
      // Unauthenticated on purpose: any HTTP answer proves the service is there, and no judgement
      // is spent - the key is only ever sent with a real request.
      try {
        await request(endpoint(environment), { method: 'HEAD', signal: AbortSignal.timeout(STATUS_TIMEOUT_MS) })
        return { state: 'reachable' }
      } catch (error) {
        return { state: 'unreachable', reason: errorMessage(error) }
      }
    }
  }
}
