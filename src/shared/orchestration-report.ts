import {
  DIFFICULTY_TIERS,
  type DifficultyTier,
  type OrchestrationRecord,
  type OrchestrationTicket,
  type TicketRoute
} from './orchestration'
import type { TierMapping, TierMappingEntry } from './orchestration-routing'

/**
 * The routing report (#40; plan in `docs/plans/orchestrator-mode.md`): the feedback loop that keeps
 * the tier mapping honest. Across every orchestration record of a project it counts, per tier and
 * model, how the routed tickets did, and proposes a mapping change only once enough of them have
 * settled to carry one. It reads and proposes; it never writes the mapping - the human applies a
 * proposal, or asks an agent to.
 *
 * Jev's routes and the orchestrator's own are counted apart: the orchestrator judging tiers while
 * Jev was unavailable says nothing about how well Jev judges them, so only Jev's routes feed a
 * proposal.
 */

/**
 * How many settled tickets a tier and model need before the report proposes anything from them. Ten,
 * because the plan's own example ("9/10 without escalation") is the smallest sample it would act on.
 */
export const ROUTING_REPORT_MINIMUM_SAMPLE = 10

/** Below this share merged without escalation, the tier's model is proposed one tier up. */
export const ROUTING_REPORT_RAISE_BELOW = 0.7

/** At or above this share, a cheaper tier's model is proposed in place of the tier's own. */
export const ROUTING_REPORT_LOWER_FROM = 0.9

/** What a ticket session's outcome record adds to a run: its turn count, and its `route:` fields. */
export interface RoutingRunOutcome {
  turns?: number
  route?: Pick<TicketRoute, 'tier' | 'model' | 'routedBy' | 'escalated'>
}

export interface RoutingReportRow {
  tier: DifficultyTier
  model: string
  /** Tickets that ran on this tier and model at least once. */
  tickets: number
  /** Merged on it, having been routed there directly. */
  mergedWithoutEscalation: number
  /** Merged on it after being escalated to it from a lower tier. */
  mergedAfterEscalation: number
  /** Escalated away from it to a higher tier. */
  escalated: number
  /** Left unmerged on it, or moved to another model without going a tier up. */
  unmerged: number
  /** Still running on it: the ticket is pending and this was its latest run. */
  inProgress: number
  /** Median of each ticket's turns on this tier and model, over those whose outcome record says. */
  medianTurns: number | null
  /**
   * The evidence a proposal is judged on: settled tickets routed straight to this tier. A ticket
   * escalated in was misjudged a tier lower, so its result says nothing about tickets judged here.
   */
  sample: number
}

export interface MappingProposal {
  tier: DifficultyTier
  from: TierMappingEntry
  to: TierMappingEntry
  evidence: { model: string; mergedWithoutEscalation: number; sample: number }
  /** One line for the review list, e.g. `high → sonnet: 9/10 Jev-routed high tickets merged without escalation`. */
  summary: string
}

export interface RoutingReport {
  /** How many orchestration records the report was built from. */
  orchestrations: number
  minimumSample: number
  /** Tickets whose route Jev judged. */
  jev: RoutingReportRow[]
  /** Tickets whose tier the orchestrator judged itself, or whose model it named: never Jev's. */
  orchestrator: RoutingReportRow[]
  /** Runs with no tier, model or `routedBy` anywhere on record, so they fit no row. */
  skippedRuns: number
  /** Empty when no mapping was supplied, or when no evidence reached the minimum sample. */
  proposals: MappingProposal[]
}

type Group = 'jev' | 'orchestrator'

/** A run that can be counted: its tier, model and who judged the tier are all known. */
interface CountedRun {
  group: Group
  tier: DifficultyTier
  model: string
  escalated: boolean
  turns?: number
}

type Result = 'mergedWithoutEscalation' | 'mergedAfterEscalation' | 'escalated' | 'unmerged' | 'inProgress'

/** One ticket's stay on one tier and model: consecutive runs there, folded into one result. */
interface Stay {
  group: Group
  tier: DifficultyTier
  model: string
  result: Result
  turns?: number
}

const tierIndex = (tier: DifficultyTier): number => DIFFICULTY_TIERS.indexOf(tier)

/**
 * A ticket's runs, oldest first. The route a run launched on (kept in the orchestration record) wins
 * over the outcome record's `route:` line, which a later turn boundary could rewrite with an
 * escalated route; a record written before runs were kept has only its latest session to go by.
 */
function ticketRuns(
  ticket: OrchestrationTicket,
  outcomes: ReadonlyMap<string, RoutingRunOutcome>
): { counted: CountedRun[]; skipped: number } {
  const runs =
    ticket.runs ?? (ticket.session ? [{ conversationId: ticket.session.conversationId, route: ticket.route }] : [])
  const counted: CountedRun[] = []
  let skipped = 0
  for (const run of runs) {
    const outcome = run.conversationId ? outcomes.get(run.conversationId) : undefined
    const route = run.route?.tier && run.route.model && run.route.routedBy ? run.route : (outcome?.route ?? run.route)
    if (!route?.tier || !route.model || !route.routedBy) {
      skipped += 1
      continue
    }
    counted.push({
      group: route.routedBy,
      tier: route.tier,
      model: route.model,
      escalated: route.escalated === true,
      ...(outcome?.turns !== undefined ? { turns: outcome.turns } : {})
    })
  }
  return { counted, skipped }
}

/**
 * Folds a ticket's runs into stays - consecutive runs on one tier and model - and decides each
 * stay's result: a later stay a tier up means it was escalated away, a later one that is not means
 * it did not merge there; the last stay takes the ticket's merge status.
 */
function ticketStays(ticket: OrchestrationTicket, runs: readonly CountedRun[]): Stay[] {
  const groups: CountedRun[][] = []
  for (const run of runs) {
    const last = groups.at(-1)?.[0]
    if (last && last.group === run.group && last.tier === run.tier && last.model === run.model) groups.at(-1)!.push(run)
    else groups.push([run])
  }
  return groups.map((group, index) => {
    const [first] = group as [CountedRun, ...CountedRun[]]
    const next = groups[index + 1]?.[0]
    let result: Result
    if (next) result = tierIndex(next.tier) > tierIndex(first.tier) ? 'escalated' : 'unmerged'
    else if (ticket.mergeStatus === 'merged')
      result = first.escalated ? 'mergedAfterEscalation' : 'mergedWithoutEscalation'
    else result = ticket.mergeStatus === 'unmerged' ? 'unmerged' : 'inProgress'
    const known = group.flatMap((run) => (run.turns === undefined ? [] : [run.turns]))
    return {
      group: first.group,
      tier: first.tier,
      model: first.model,
      result,
      ...(known.length > 0 ? { turns: known.reduce((sum, turns) => sum + turns, 0) } : {})
    }
  })
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

function rowsFor(stays: readonly Stay[]): RoutingReportRow[] {
  const byPair = new Map<string, Stay[]>()
  for (const stay of stays) {
    const key = `${tierIndex(stay.tier)}\u0000${stay.model}`
    byPair.set(key, [...(byPair.get(key) ?? []), stay])
  }
  return [...byPair.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, pair]) => {
      const count = (result: Result): number => pair.filter((stay) => stay.result === result).length
      const directSettled = pair.filter(
        (stay) => stay.result !== 'inProgress' && stay.result !== 'mergedAfterEscalation'
      ).length
      return {
        tier: pair[0].tier,
        model: pair[0].model,
        tickets: pair.length,
        mergedWithoutEscalation: count('mergedWithoutEscalation'),
        mergedAfterEscalation: count('mergedAfterEscalation'),
        escalated: count('escalated'),
        unmerged: count('unmerged'),
        inProgress: count('inProgress'),
        medianTurns: median(pair.flatMap((stay) => (stay.turns === undefined ? [] : [stay.turns]))),
        sample: directSettled
      }
    })
}

const entryLabel = (entry: TierMappingEntry): string =>
  entry.effort ? `${entry.model} at ${entry.effort}` : entry.model
const sameEntry = (a: TierMappingEntry, b: TierMappingEntry): boolean => a.model === b.model && a.effort === b.effort

/**
 * Mapping changes Jev's evidence supports, at most one per tier, each carrying its numbers. A tier
 * is proposed down to the cheapest lower tier's model that merged at least `ROUTING_REPORT_LOWER_FROM`
 * of its tickets without escalation; failing that, up to the next tier's entry when its own model
 * merged fewer than `ROUTING_REPORT_RAISE_BELOW`. Nothing is proposed from fewer than
 * `ROUTING_REPORT_MINIMUM_SAMPLE` settled tickets, and frontier has nowhere higher to go.
 */
export function proposeMappingChanges(rows: readonly RoutingReportRow[], mapping: TierMapping): MappingProposal[] {
  const proposals: MappingProposal[] = []
  const evidenceFor = (tier: DifficultyTier, model: string): RoutingReportRow | undefined => {
    const row = rows.find((candidate) => candidate.tier === tier && candidate.model === model)
    return row && row.sample >= ROUTING_REPORT_MINIMUM_SAMPLE ? row : undefined
  }
  const rate = (row: RoutingReportRow): number => row.mergedWithoutEscalation / row.sample
  const numbers = (row: RoutingReportRow) => ({
    model: row.model,
    mergedWithoutEscalation: row.mergedWithoutEscalation,
    sample: row.sample
  })
  for (const tier of DIFFICULTY_TIERS) {
    const from = mapping[tier]
    const cheaper = DIFFICULTY_TIERS.slice(0, tierIndex(tier))
      .map((lower) => mapping[lower].model)
      .filter((model) => model !== from.model)
      .map((model) => evidenceFor(tier, model))
      .find((row) => row !== undefined && rate(row) >= ROUTING_REPORT_LOWER_FROM)
    if (cheaper) {
      proposals.push({
        tier,
        from,
        to: { model: cheaper.model },
        evidence: numbers(cheaper),
        summary: `${tier} → ${cheaper.model}: ${cheaper.mergedWithoutEscalation}/${cheaper.sample} Jev-routed ${tier} tickets merged without escalation`
      })
      continue
    }
    const higher = DIFFICULTY_TIERS[tierIndex(tier) + 1]
    const own = evidenceFor(tier, from.model)
    if (!higher || !own || rate(own) >= ROUTING_REPORT_RAISE_BELOW || sameEntry(mapping[higher], from)) continue
    const to = mapping[higher]
    proposals.push({
      tier,
      from,
      to,
      evidence: numbers(own),
      summary: `${tier} → ${entryLabel(to)}: ${own.model} merged only ${own.mergedWithoutEscalation}/${own.sample} Jev-routed ${tier} tickets without escalation`
    })
  }
  return proposals
}

/**
 * The report over a project's orchestration records. `outcomes` is each ticket session's outcome
 * record by conversation id; `mapping` is the project's effective tier mapping, which proposals are
 * made against - absent, the report only counts.
 */
export function routingReport(
  records: readonly OrchestrationRecord[],
  outcomes: ReadonlyMap<string, RoutingRunOutcome>,
  mapping?: TierMapping
): RoutingReport {
  const stays: Stay[] = []
  let skippedRuns = 0
  for (const record of records) {
    for (const ticket of record.tickets) {
      const { counted, skipped } = ticketRuns(ticket, outcomes)
      skippedRuns += skipped
      stays.push(...ticketStays(ticket, counted))
    }
  }
  const jev = rowsFor(stays.filter((stay) => stay.group === 'jev'))
  return {
    orchestrations: records.length,
    minimumSample: ROUTING_REPORT_MINIMUM_SAMPLE,
    jev,
    orchestrator: rowsFor(stays.filter((stay) => stay.group === 'orchestrator')),
    skippedRuns,
    proposals: mapping ? proposeMappingChanges(jev, mapping) : []
  }
}
