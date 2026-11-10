import { strict as assert } from 'node:assert'
import { test } from 'vitest'
import type { SessionConfigOption } from '@agentclientprotocol/sdk'
import { effortSelectorFromConfigOptions } from '../src/shared/agent-effort'
import { modelSelectorFromConfigOptions } from '../src/shared/agent-models'

const modeOption: SessionConfigOption = {
  id: 'mode',
  name: 'Mode',
  category: 'mode',
  type: 'select',
  currentValue: 'default',
  options: [{ value: 'default', name: 'Default' }]
}

test("reads the model selector out of an agent's config options", () => {
  const selector = modelSelectorFromConfigOptions([
    modeOption,
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: 'claude-sonnet-5',
      options: [
        { value: 'claude-opus-5', name: 'Opus 5', description: 'Most capable' },
        { value: 'claude-sonnet-5', name: 'Sonnet 5' }
      ]
    }
  ])

  assert.deepEqual(selector, {
    configId: 'model',
    models: {
      currentModelId: 'claude-sonnet-5',
      availableModels: [
        { id: 'claude-opus-5', name: 'Opus 5', description: 'Most capable' },
        { id: 'claude-sonnet-5', name: 'Sonnet 5' }
      ]
    }
  })
})

test('flattens grouped model options into one selectable list', () => {
  const selector = modelSelectorFromConfigOptions([
    {
      id: 'acp-model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: 'gpt-5-codex',
      options: [
        { group: 'recommended', name: 'Recommended', options: [{ value: 'gpt-5-codex', name: 'GPT-5 Codex' }] },
        { group: 'legacy', name: 'Legacy', options: [{ value: 'gpt-5', name: 'GPT-5' }] }
      ]
    }
  ])

  assert.equal(selector?.configId, 'acp-model')
  assert.deepEqual(
    selector?.models.availableModels.map((model) => model.id),
    ['gpt-5-codex', 'gpt-5']
  )
})

test('falls back to the conventional id when an agent omits the category hint', () => {
  const selector = modelSelectorFromConfigOptions([
    {
      id: 'model',
      name: 'Model',
      type: 'select',
      currentValue: 'sonnet',
      options: [{ value: 'sonnet', name: 'Sonnet' }]
    }
  ])

  assert.equal(selector?.models.currentModelId, 'sonnet')
})

test('reports no selector when the agent offers no model choice', () => {
  assert.equal(modelSelectorFromConfigOptions(undefined), undefined)
  assert.equal(modelSelectorFromConfigOptions([]), undefined)
  assert.equal(modelSelectorFromConfigOptions([modeOption]), undefined)
  assert.equal(
    modelSelectorFromConfigOptions([
      { id: 'model', name: 'Fast mode', category: 'model', type: 'boolean', currentValue: true }
    ]),
    undefined
  )
})

test("claude-agent-acp 0.104's Fast mode and ultracode toggles never stand in for the model or effort", () => {
  // The order and shape claude-agent-acp 0.104.0 advertises for a client without boolean options:
  // both toggles are On/Off selects in `model_config`, listed after model and effort.
  const toggle = (id: string, name: string): SessionConfigOption => ({
    id,
    name,
    category: 'model_config',
    type: 'select',
    currentValue: 'off',
    options: [
      { value: 'on', name: 'On' },
      { value: 'off', name: 'Off' }
    ]
  })
  const configOptions: SessionConfigOption[] = [
    modeOption,
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: 'fable',
      options: [
        { value: 'opus', name: 'Opus 5.5' },
        { value: 'fable', name: 'Fable 5.2' }
      ]
    },
    {
      id: 'effort',
      name: 'Effort',
      category: 'thought_level',
      type: 'select',
      currentValue: 'high',
      options: [
        { value: 'high', name: 'High' },
        { value: 'xhigh', name: 'Xhigh' }
      ]
    },
    toggle('fast', 'Fast mode'),
    toggle('ultracode', 'Ultracode')
  ]

  assert.equal(modelSelectorFromConfigOptions(configOptions)?.configId, 'model')
  assert.equal(modelSelectorFromConfigOptions(configOptions)?.models.currentModelId, 'fable')
  assert.equal(effortSelectorFromConfigOptions(configOptions)?.configId, 'effort')
  // Without the model and effort selectors nothing is offered at all, rather than a toggle as one.
  const togglesOnly = [modeOption, toggle('fast', 'Fast mode'), toggle('ultracode', 'Ultracode')]
  assert.equal(modelSelectorFromConfigOptions(togglesOnly), undefined)
  assert.equal(effortSelectorFromConfigOptions(togglesOnly), undefined)
})
