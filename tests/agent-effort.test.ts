import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { effortSelectorFromConfigOptions } from '../src/shared/agent-effort'

test('reads only the effort values advertised for the selected provider/model', () => {
  const selector = effortSelectorFromConfigOptions([
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: 'gpt-5',
      options: [{ value: 'gpt-5', name: 'GPT-5' }]
    },
    {
      id: 'reasoning_effort',
      name: 'Reasoning effort',
      category: 'thought_level',
      type: 'select',
      currentValue: 'high',
      options: [
        { value: 'low', name: 'Low' },
        { value: 'high', name: 'High', description: 'More reasoning' }
      ]
    }
  ])

  assert.deepEqual(selector, {
    configId: 'reasoning_effort',
    efforts: {
      currentEffortId: 'high',
      availableEfforts: [
        { id: 'low', name: 'Low' },
        { id: 'high', name: 'High', description: 'More reasoning' }
      ]
    }
  })
})

test('does not invent a universal effort selector when the harness advertises none', () => {
  assert.equal(effortSelectorFromConfigOptions(undefined), undefined)
  assert.equal(
    effortSelectorFromConfigOptions([
      {
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: 'opus',
        options: [{ value: 'opus', name: 'Opus' }]
      }
    ]),
    undefined
  )
})
