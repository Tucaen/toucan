import { describe, expect, it } from 'vitest'
import { DEFAULT_ORCHESTRATION_CONFIG } from '../src/shared/orchestration-routing'
import {
  effortChoices,
  modelChoices,
  projectFileFromDraft,
  userDraft,
  userFileFromDraft
} from '../src/shared/orchestration-settings'
import { TICKET_CONTRACT_SUMMARY, ticketContract } from '../src/shared/orchestration'

// The orchestration settings panel (#39) edits the files #36 reads. What it offers per tier and
// what it writes back are decided here, so the dialog only renders them.

const models = [
  { id: 'haiku', name: 'Haiku 4.5' },
  { id: 'sonnet', name: 'Sonnet 5.5' },
  { id: 'opus', name: 'Opus 5.5' }
]

describe('model choices', () => {
  it('lists the chat picker models and marks the mapped one', () => {
    const choices = modelChoices('sonnet', models)
    expect(choices.map((choice) => choice.id)).toEqual(['haiku', 'sonnet', 'opus'])
    expect(choices.find((choice) => choice.selected)?.id).toBe('sonnet')
    expect(choices.every((choice) => !choice.missing)).toBe(true)
  })

  it('keeps a mapped model the picker no longer offers, marked missing', () => {
    const choices = modelChoices('opus-4', models)
    expect(choices.at(-1)).toMatchObject({ id: 'opus-4', name: 'opus-4', missing: true, selected: true })
  })

  it('cannot call a model missing while no model list is known', () => {
    expect(modelChoices('opus', [])).toEqual([{ id: 'opus', name: 'opus', missing: false, selected: true }])
  })
})

describe('effort choices', () => {
  it('offers following the depth score plus the efforts the model offers', () => {
    const choices = effortChoices(undefined, ['low', 'high'])
    expect(choices.map((choice) => choice.id)).toEqual([undefined, 'low', 'high'])
    expect(choices[0]?.selected).toBe(true)
  })

  it('keeps a mapped effort the model does not offer, marked missing', () => {
    const choices = effortChoices('max', ['low', 'high'])
    expect(choices.at(-1)).toMatchObject({ id: 'max', missing: true, selected: true })
  })

  it('offers the ladder unchecked while no session has run the model', () => {
    const choices = effortChoices('max', undefined)
    expect(choices.map((choice) => choice.id)).toEqual([undefined, 'low', 'medium', 'high', 'xhigh', 'max'])
    expect(choices.every((choice) => !choice.missing)).toBe(true)
  })
})

describe('drafts and files', () => {
  it('drafts the user tab from the file over the defaults', () => {
    expect(userDraft(undefined)).toEqual(DEFAULT_ORCHESTRATION_CONFIG)
    expect(userDraft({ tiers: { low: { model: 'sonnet' } } }).tiers.low).toEqual({ model: 'sonnet' })
  })

  it('writes the user tab whole, leaving out a blank skill so the default applies', () => {
    const draft = { ...DEFAULT_ORCHESTRATION_CONFIG, implementationSkill: '  ' }
    expect(userFileFromDraft(draft)).toEqual({ tiers: DEFAULT_ORCHESTRATION_CONFIG.tiers })
    expect(userFileFromDraft({ ...draft, implementationSkill: ' /tdd ' }).implementationSkill).toBe('/tdd')
  })

  it('writes the project tab with only what it overrides', () => {
    expect(projectFileFromDraft({ implementationSkill: '' })).toEqual({})
    expect(projectFileFromDraft({ tiers: {} })).toEqual({})
    expect(projectFileFromDraft({ tiers: { high: { model: 'sonnet' } }, implementationSkill: '/tdd' })).toEqual({
      tiers: { high: { model: 'sonnet' } },
      implementationSkill: '/tdd'
    })
  })
})

it('summarises the ticket contract for the implementation-skill field', () => {
  expect(TICKET_CONTRACT_SUMMARY.must.join(' ')).toMatch(/implement.*test.*review.*commit.*worktree/i)
  expect(TICKET_CONTRACT_SUMMARY.must.join(' ')).toMatch(/final report/i)
  expect(TICKET_CONTRACT_SUMMARY.mustNot.join(' ')).toMatch(/push.*merge.*pull request.*leave the worktree/i)
})

it('summarises nothing the binding ticket contract does not say', () => {
  const contract = ticketContract({ path: 'worktree', branch: 'ticket' }).toLowerCase()
  for (const rule of ['push', 'merge', 'pull request', 'worktree', 'commit', 'final report']) {
    expect(contract).toContain(rule)
  }
})
