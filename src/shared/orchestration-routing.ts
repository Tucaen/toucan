import { isRecord } from './record'
import type { AgentProvider } from './agent-provider'
import {
  DEFAULT_IMPLEMENTATION_SKILL,
  DIFFICULTY_TIERS,
  isDifficultyTier,
  type DifficultyTier,
  type TicketRoute
} from './orchestration'

/**
 * Difficulty-tier routing (#36; plan in `docs/plans/orchestrator-mode.md`). Jev judges how hard a
 * ticket is and never sees a model; the user's **tier mapping** turns that tier into a model from
 * the chat node's model picker, and Toucan settles the effort against what that model's picker
 * offers. Everything here is pure, so the mapping's resolution, its missing-model fallback and
 * escalation are decided once and tested without a session.
 */

export interface TierMappingEntry {
  /** A model id as the chat node's model picker lists it (`haiku`, `sonnet`, `opus`, ...). */
  model: string
  /** A fixed effort for this tier; absent, the effort follows the ticket's reasoning-depth score. */
  effort?: string
}

export type TierMapping = Record<DifficultyTier, TierMappingEntry>

export interface OrchestrationConfig {
  tiers: TierMapping
  /** What a ticket session's prompt opens with, before the ticket and the ticket contract. */
  implementationSkill: string
}

/** One provider's entry in the user file or a project's override. */
export interface ProviderOrchestrationConfigFile {
  tiers?: Partial<TierMapping>
  implementationSkill?: string
}

/**
 * One configuration file. Provider entries coexist so a Codex mapping can never reinterpret or
 * overwrite Claude's model ids. `parseOrchestrationConfig` migrates the former top-level shape to
 * the `claude` entry in memory.
 */
export type OrchestrationConfigFile = Partial<Record<AgentProvider, ProviderOrchestrationConfigFile>>

export const DEFAULT_ORCHESTRATION_CONFIG: OrchestrationConfig = {
  tiers: {
    low: { model: 'haiku' },
    medium: { model: 'sonnet' },
    high: { model: 'opus' },
    frontier: { model: 'opus', effort: 'max' }
  },
  implementationSkill: DEFAULT_IMPLEMENTATION_SKILL
}

/**
 * Below this Jev confidence a route still runs on its tier but the ticket is marked for review -
 * the threshold the router experiment (`route-claude-ticket`) used.
 */
export const ROUTE_REVIEW_CONFIDENCE = 0.6

type Outcome<K extends string, T> =
  ({ [key in K]: T } & { error?: undefined }) | ({ [key in K]?: undefined } & { error: string })

const nonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.trim() !== ''

/**
 * Validates one configuration file. Unknown fields are refused rather than ignored: the files are
 * meant to be edited by hand or by an agent, and a misspelt tier silently falling back to the
 * default is the one mistake nobody would notice.
 */
function parseProviderConfig(value: unknown, prefix = ''): Outcome<'config', ProviderOrchestrationConfigFile> {
  if (!isRecord(value)) return { error: `${prefix || 'the provider configuration'} must be a JSON object` }
  const config: ProviderOrchestrationConfigFile = {}
  for (const [key, field] of Object.entries(value)) {
    if (key === 'implementationSkill') {
      if (!nonEmptyString(field)) return { error: `${prefix}implementationSkill must be a non-empty string` }
      config.implementationSkill = field.trim()
    } else if (key === 'tiers') {
      if (!isRecord(field)) return { error: `${prefix}tiers must be an object keyed by tier` }
      const tiers: Partial<TierMapping> = {}
      for (const [tier, entry] of Object.entries(field)) {
        if (!isDifficultyTier(tier)) {
          return { error: `${prefix}unknown tier "${tier}"; the tiers are ${DIFFICULTY_TIERS.join(', ')}` }
        }
        if (!isRecord(entry) || !nonEmptyString(entry.model)) {
          return { error: `${prefix}tiers.${tier}.model must be a model id from the chat node's model picker` }
        }
        for (const entryKey of Object.keys(entry)) {
          if (entryKey !== 'model' && entryKey !== 'effort')
            return { error: `${prefix}tiers.${tier} has unknown field "${entryKey}"` }
        }
        if (entry.effort !== undefined && !nonEmptyString(entry.effort)) {
          return {
            error: `${prefix}tiers.${tier}.effort must be an effort id such as low, medium, high, xhigh or max`
          }
        }
        tiers[tier] = {
          model: entry.model.trim(),
          ...(nonEmptyString(entry.effort) ? { effort: entry.effort.trim() } : {})
        }
      }
      config.tiers = tiers
    } else {
      return { error: `${prefix}unknown field "${key}"; a provider entry holds tiers and implementationSkill` }
    }
  }
  return { config }
}

export function parseOrchestrationConfig(value: unknown): Outcome<'config', OrchestrationConfigFile> {
  if (!isRecord(value)) return { error: 'the orchestration configuration must be a JSON object' }
  const keys = Object.keys(value)
  const legacy = keys.some((key) => key === 'tiers' || key === 'implementationSkill')
  if (legacy) {
    if (keys.some((key) => key !== 'tiers' && key !== 'implementationSkill')) {
      return { error: 'legacy Claude fields cannot be mixed with provider entries; move them under "claude"' }
    }
    const parsed = parseProviderConfig(value)
    return parsed.error !== undefined ? parsed : { config: { claude: parsed.config } }
  }
  const config: OrchestrationConfigFile = {}
  for (const [provider, field] of Object.entries(value)) {
    if (provider !== 'claude' && provider !== 'codex') {
      return { error: `unknown provider "${provider}"; the providers are claude and codex` }
    }
    const parsed = parseProviderConfig(field, `${provider}.`)
    if (parsed.error !== undefined) return parsed
    config[provider] = parsed.config
  }
  return { config }
}

/** The tiers a provider still needs after user and project entries have been combined. */
export function missingProviderTiers(
  provider: AgentProvider,
  user: OrchestrationConfigFile | undefined,
  project: OrchestrationConfigFile | undefined
): DifficultyTier[] {
  if (provider === 'claude') return []
  const tiers = { ...user?.[provider]?.tiers, ...project?.[provider]?.tiers }
  return DIFFICULTY_TIERS.filter((tier) => !tiers[tier])
}

/**
 * The configuration a project routes with: its provider-specific project override over its user
 * entry. Claude retains the historical defaults. Codex has no model defaults and is therefore
 * undefined until all four tiers are configured.
 */
export function effectiveOrchestrationConfig(
  provider: AgentProvider,
  user: OrchestrationConfigFile | undefined,
  project: OrchestrationConfigFile | undefined
): OrchestrationConfig | undefined {
  const userEntry = user?.[provider]
  const projectEntry = project?.[provider]
  if (missingProviderTiers(provider, user, project).length > 0) return undefined
  return {
    tiers: {
      ...(provider === 'claude' ? DEFAULT_ORCHESTRATION_CONFIG.tiers : {}),
      ...userEntry?.tiers,
      ...projectEntry?.tiers
    } as TierMapping,
    implementationSkill:
      projectEntry?.implementationSkill ??
      userEntry?.implementationSkill ??
      DEFAULT_ORCHESTRATION_CONFIG.implementationSkill
  }
}

/** The efforts in order of how much reasoning they buy; the Claude adapter's own ids. */
export const EFFORT_LADDER = ['low', 'medium', 'high', 'xhigh', 'max'] as const

/**
 * Jev's reasoning-depth score (0-4, one step per criterion) on the effort ladder.
 * @internal exported for tests
 */
export function depthEffort(depth: number): string {
  if (depth < 0.75) return 'low'
  if (depth < 1.75) return 'medium'
  if (depth < 2.75) return 'high'
  if (depth < 3.5) return 'xhigh'
  return 'max'
}

/** The effort a tier asks for when neither the mapping nor a depth score names one. */
const TIER_EFFORT: Record<DifficultyTier, string> = { low: 'low', medium: 'medium', high: 'high', frontier: 'max' }

/**
 * The offered effort nearest the wanted one on the ladder, the higher on a tie - under-thinking a
 * ticket is the costlier mistake. Undefined when the list holds nothing on the ladder, which
 * includes a model whose picker offers no effort at all. An effort off the ladder is kept only
 * when the picker offers it verbatim.
 * @internal exported for tests
 */
export function nearestEffort(wanted: string, offered: readonly string[]): string | undefined {
  const ladder: readonly string[] = EFFORT_LADDER
  const target = ladder.indexOf(wanted)
  if (target < 0) return offered.includes(wanted) ? wanted : undefined
  const candidates = offered.filter((effort) => ladder.includes(effort))
  let best: string | undefined
  let bestDistance = Infinity
  for (const effort of candidates) {
    const index = ladder.indexOf(effort)
    const distance = Math.abs(index - target)
    if (distance < bestDistance || (distance === bestDistance && index > target)) {
      best = effort
      bestDistance = distance
    }
  }
  return best
}

/** What the chat node's model picker offers, as main last saw it. */
export interface OfferedModels {
  /** Model ids; empty while no Claude session has advertised a list yet. */
  models: readonly string[]
  /** The efforts a model's picker offers; undefined while no session has run that model. */
  efforts(model: string): readonly string[] | undefined
}

/**
 * The tier above, or undefined above `frontier`.
 * @internal exported for tests
 */
export function nextTier(tier: DifficultyTier): DifficultyTier | undefined {
  return DIFFICULTY_TIERS[DIFFICULTY_TIERS.indexOf(tier) + 1]
}

export interface ResolvedTier {
  route: Required<Pick<TicketRoute, 'tier' | 'model' | 'effort'>>
  /** The fallback and anything else the caller reports without refusing. */
  warnings: string[]
}

/**
 * A tier through the mapping. The ticket keeps its tier even when its model falls back: the tier
 * is Jev's judgement of the ticket, the model only what the mapping could supply for it.
 */
export function resolveTier(
  tier: DifficultyTier,
  depth: number | undefined,
  config: OrchestrationConfig,
  offered: OfferedModels
):
  | { route: ResolvedTier['route']; warnings: string[]; error?: undefined }
  | { route?: undefined; warnings: string[]; error: string } {
  const warnings: string[] = []
  const mapped = config.tiers[tier]
  const wantedEffort = mapped.effort ?? (depth === undefined ? TIER_EFFORT[tier] : depthEffort(depth))
  let source: DifficultyTier | undefined = tier
  if (offered.models.length === 0) {
    warnings.push('no model list is known for this provider yet, so the tier mapping is used unchecked')
  } else {
    while (source && !offered.models.includes(config.tiers[source].model)) source = nextTier(source)
    if (!source) {
      return {
        warnings,
        error:
          `the ${tier} tier's model "${mapped.model}" is not offered and no higher tier's model is either; ` +
          `the picker offers ${offered.models.join(', ')}. Fix the tier mapping.`
      }
    }
    if (source !== tier) {
      warnings.push(
        `the ${tier} tier's model "${mapped.model}" is not offered, so the ${source} tier's model ` +
          `"${config.tiers[source].model}" is used instead`
      )
    }
  }
  const model = config.tiers[source ?? tier].model
  const efforts = offered.efforts(model)
  const settled = efforts && nearestEffort(wantedEffort, efforts)
  // Not refused: the spawn reports the effort the session actually runs at.
  if (!settled && offered.models.length > 0) {
    warnings.push(
      efforts
        ? `model "${model}" offers no effort choice, so effort "${wantedEffort}" is requested unchecked`
        : `no session has run model "${model}" yet, so effort "${wantedEffort}" is requested unchecked`
    )
  }
  const effort = settled ?? wantedEffort
  return { route: { tier, model, effort }, warnings }
}

/**
 * One tier up (#36): the ticket failed on its tier, so it gets the next one's model, re-resolved
 * against today's picker, and keeps its depth score and how it was routed. Past `frontier` there is
 * nothing stronger, and the ticket belongs on the review list.
 */
export function escalateRoute(
  route: TicketRoute | undefined,
  config: OrchestrationConfig,
  offered: OfferedModels
):
  | { route: TicketRoute; warnings: string[]; error?: undefined }
  | { route?: undefined; warnings: string[]; error: string } {
  if (!route?.tier) return { warnings: [], error: 'the ticket has no tier yet; route it first' }
  const tier = nextTier(route.tier)
  if (!tier)
    return { warnings: [], error: 'the ticket is already at frontier; there is no higher tier, so list it for review' }
  const resolved = resolveTier(tier, route.depth, config, offered)
  if (resolved.error !== undefined) return resolved
  return { route: { ...route, ...resolved.route, escalated: true }, warnings: resolved.warnings }
}

/**
 * Whether Jev can route an orchestration, as the orchestrator node shows it before launch (#36).
 * `reachable` is the service answering, not a judgement spent; the key itself never leaves main.
 */
export type JevReachability = { state: 'reachable' } | { state: 'no-key' } | { state: 'unreachable'; reason: string }

export function isJevReachability(value: unknown): value is JevReachability {
  if (!isRecord(value)) return false
  if (value.state === 'reachable' || value.state === 'no-key') return true
  return value.state === 'unreachable' && typeof value.reason === 'string'
}
