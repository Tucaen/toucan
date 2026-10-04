import { strict as assert } from 'node:assert'
import { test } from 'vitest'
import {
  DEFAULT_ORCHESTRATION_CONFIG,
  depthEffort,
  effectiveOrchestrationConfig,
  escalateRoute,
  nearestEffort,
  nextTier,
  parseOrchestrationConfig,
  resolveTier,
  ROUTE_REVIEW_CONFIDENCE,
  type OfferedModels
} from '../src/shared/orchestration-routing'

// Difficulty-tier routing (#36, docs/plans/orchestrator-mode.md): Jev names a tier, the user's tier
// mapping names the model, and Toucan settles the effort against what that model's picker offers.

const offered = (models: string[], efforts: Record<string, string[]> = {}): OfferedModels => ({
  models,
  efforts: (model) => efforts[model]
})

const ALL = offered(['haiku', 'sonnet', 'opus'], {
  haiku: [],
  sonnet: ['low', 'medium', 'high'],
  opus: ['low', 'medium', 'high', 'xhigh', 'max']
})

test('the defaults map low to Haiku, medium to Sonnet, high and frontier to Opus, frontier at max', () => {
  assert.deepEqual(DEFAULT_ORCHESTRATION_CONFIG, {
    tiers: {
      low: { model: 'haiku' },
      medium: { model: 'sonnet' },
      high: { model: 'opus' },
      frontier: { model: 'opus', effort: 'max' }
    },
    implementationSkill: '/implement'
  })
})

test('legacy files migrate to Claude, and provider entries remain separate', () => {
  assert.deepEqual(parseOrchestrationConfig({ tiers: { low: { model: 'sonnet' } } }), {
    config: { claude: { tiers: { low: { model: 'sonnet' } } } }
  })
  assert.deepEqual(parseOrchestrationConfig({ codex: { tiers: { low: { model: 'gpt-5.5' } } } }), {
    config: { codex: { tiers: { low: { model: 'gpt-5.5' } } } }
  })
  assert.deepEqual(parseOrchestrationConfig({}), { config: {} })
  assert.match(parseOrchestrationConfig({ tiers: { easy: { model: 'x' } } }).error!, /unknown tier "easy"/)
  assert.match(parseOrchestrationConfig({ codex: { tiers: { low: {} } } }).error!, /codex\.tiers\.low\.model/)
  assert.match(parseOrchestrationConfig({ codex: { tiers: { low: { model: 'gpt', effort: 3 } } } }).error!, /effort/)
  assert.match(parseOrchestrationConfig({ implementationSkill: ' ' }).error!, /implementationSkill/)
  assert.match(parseOrchestrationConfig({ tier: {} }).error!, /unknown provider "tier"/)
  assert.match(
    parseOrchestrationConfig({ tiers: {}, codex: { tiers: {} } }).error!,
    /legacy Claude fields cannot be mixed/
  )
  assert.match(parseOrchestrationConfig([]).error!, /JSON object/)
})

test('a project override replaces the tiers it names and the skill; the user file fills the rest', () => {
  const config = effectiveOrchestrationConfig(
    'claude',
    {
      claude: {
        tiers: { low: { model: 'sonnet' }, high: { model: 'claude-fable-5[1m]' } },
        implementationSkill: '/tdd'
      }
    },
    { claude: { tiers: { high: { model: 'opus', effort: 'xhigh' } }, implementationSkill: '/implement-in-worktree' } }
  )!
  assert.deepEqual(config.tiers.low, { model: 'sonnet' })
  assert.deepEqual(config.tiers.medium, DEFAULT_ORCHESTRATION_CONFIG.tiers.medium)
  assert.deepEqual(config.tiers.high, { model: 'opus', effort: 'xhigh' })
  assert.equal(config.implementationSkill, '/implement-in-worktree')
  assert.deepEqual(effectiveOrchestrationConfig('claude', undefined, undefined), DEFAULT_ORCHESTRATION_CONFIG)
})

test('Codex has no invented defaults and becomes usable only from its own complete mapping', () => {
  const claude = { claude: { tiers: { low: { model: 'haiku' } } } }
  assert.equal(effectiveOrchestrationConfig('codex', claude, undefined), undefined)
  const config = effectiveOrchestrationConfig(
    'codex',
    {
      codex: {
        tiers: {
          low: { model: 'gpt-5.6-mini' },
          medium: { model: 'gpt-5.6' },
          high: { model: 'gpt-5.6' }
        },
        implementationSkill: '/codex-implement'
      }
    },
    { codex: { tiers: { frontier: { model: 'gpt-6' } } } }
  )!
  assert.equal(config.tiers.low.model, 'gpt-5.6-mini')
  assert.equal(config.tiers.frontier.model, 'gpt-6')
  assert.equal(config.implementationSkill, '/codex-implement')
})

test('the reasoning-depth score maps onto the effort ladder', () => {
  assert.equal(depthEffort(0), 'low')
  assert.equal(depthEffort(1), 'medium')
  assert.equal(depthEffort(2), 'high')
  assert.equal(depthEffort(3), 'xhigh')
  assert.equal(depthEffort(4), 'max')
  assert.equal(depthEffort(0.74), 'low')
  assert.equal(depthEffort(3.5), 'max')
})

test('an effort settles on the nearest one the picker offers, the higher on a tie', () => {
  assert.equal(nearestEffort('max', ['low', 'medium', 'high']), 'high')
  assert.equal(nearestEffort('medium', ['low', 'high']), 'high')
  assert.equal(nearestEffort('low', ['default', 'medium', 'max']), 'medium')
  assert.equal(nearestEffort('high', ['low', 'medium', 'high', 'xhigh', 'max']), 'high')
  // Nothing on the ladder, or no list known: nothing to settle against.
  assert.equal(nearestEffort('high', ['default']), undefined)
  assert.equal(nearestEffort('high', []), undefined)
})

test('a tier resolves to its mapped model with the effort from the depth score', () => {
  assert.deepEqual(resolveTier('medium', 2.1, DEFAULT_ORCHESTRATION_CONFIG, ALL), {
    route: { tier: 'medium', model: 'sonnet', effort: 'high' },
    warnings: []
  })
  assert.deepEqual(resolveTier('high', 4, DEFAULT_ORCHESTRATION_CONFIG, ALL).route, {
    tier: 'high',
    model: 'opus',
    effort: 'max'
  })
})

test('the mapped effort wins over the depth score, and both are settled against the picker', () => {
  assert.deepEqual(resolveTier('frontier', 0, DEFAULT_ORCHESTRATION_CONFIG, ALL).route, {
    tier: 'frontier',
    model: 'opus',
    effort: 'max'
  })
  // Sonnet offers no xhigh or max: the depth score's max settles on high.
  assert.equal(resolveTier('medium', 4, DEFAULT_ORCHESTRATION_CONFIG, ALL).route?.effort, 'high')
})

test('without a depth score the tier names its own effort', () => {
  assert.equal(resolveTier('low', undefined, DEFAULT_ORCHESTRATION_CONFIG, ALL).route?.effort, 'low')
  assert.equal(resolveTier('medium', undefined, DEFAULT_ORCHESTRATION_CONFIG, ALL).route?.effort, 'medium')
  assert.equal(resolveTier('high', undefined, DEFAULT_ORCHESTRATION_CONFIG, ALL).route?.effort, 'high')
})

test('a model whose picker offers no effort ladder keeps the wanted effort, since nothing refutes it', () => {
  // Haiku advertises no effort selector at all; the spawn reports what the session actually runs.
  assert.equal(resolveTier('low', 3, DEFAULT_ORCHESTRATION_CONFIG, ALL).route?.effort, 'xhigh')
})

test('a mapped model the picker no longer lists falls back to the next tier up, and says so', () => {
  const noHaiku = offered(['sonnet', 'opus'], { sonnet: ['low', 'medium', 'high'] })
  const resolved = resolveTier('low', 0, DEFAULT_ORCHESTRATION_CONFIG, noHaiku)
  assert.deepEqual(resolved.route, { tier: 'low', model: 'sonnet', effort: 'low' })
  assert.equal(resolved.warnings.length, 1)
  assert.match(resolved.warnings[0]!, /low tier's model "haiku" is not offered.*medium tier's model "sonnet"/)
  // Two tiers missing: the fallback keeps climbing.
  const onlyOpus = offered(['opus'])
  const climbed = resolveTier('low', 0, DEFAULT_ORCHESTRATION_CONFIG, onlyOpus)
  assert.equal(climbed.route?.model, 'opus')
  assert.match(climbed.warnings[0]!, /high tier's model "opus"/)
  // And no session has run Opus here, so its effort could not be settled either.
  assert.match(climbed.warnings[1]!, /no session has run model "opus" yet/)
})

test('a missing frontier model has nowhere to fall back to and is refused', () => {
  const resolved = resolveTier('frontier', 4, DEFAULT_ORCHESTRATION_CONFIG, offered(['haiku', 'sonnet']))
  assert.equal(resolved.route, undefined)
  assert.match(resolved.error!, /frontier.*"opus".*not offered/)
  assert.match(resolved.error!, /haiku, sonnet/)
})

test('with no model list known yet the mapping is used unchecked, with a warning', () => {
  const resolved = resolveTier('high', 2, DEFAULT_ORCHESTRATION_CONFIG, offered([]))
  assert.deepEqual(resolved.route, { tier: 'high', model: 'opus', effort: 'high' })
  assert.match(resolved.warnings[0]!, /no model list is known for this provider/)
})

test('tiers climb one step at a time and stop at frontier', () => {
  assert.equal(nextTier('low'), 'medium')
  assert.equal(nextTier('medium'), 'high')
  assert.equal(nextTier('high'), 'frontier')
  assert.equal(nextTier('frontier'), undefined)
})

test('escalation moves one tier up, re-resolves the model, keeps the depth score and marks it', () => {
  const escalated = escalateRoute(
    { tier: 'medium', model: 'sonnet', effort: 'high', depth: 2, confidence: 0.8, routedBy: 'jev' },
    DEFAULT_ORCHESTRATION_CONFIG,
    ALL
  )
  assert.deepEqual(escalated.route, {
    tier: 'high',
    model: 'opus',
    effort: 'high',
    depth: 2,
    confidence: 0.8,
    routedBy: 'jev',
    escalated: true
  })
})

test('escalation past frontier, or of a ticket with no tier, is refused', () => {
  assert.match(
    escalateRoute({ tier: 'frontier', model: 'opus' }, DEFAULT_ORCHESTRATION_CONFIG, ALL).error!,
    /already at frontier/
  )
  assert.match(escalateRoute(undefined, DEFAULT_ORCHESTRATION_CONFIG, ALL).error!, /no tier/)
})

test('the review threshold is the one the router experiment used', () => {
  assert.equal(ROUTE_REVIEW_CONFIDENCE, 0.6)
})
