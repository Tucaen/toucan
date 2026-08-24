import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { terminalLivenessDescription, terminalLivenessLabels } from '../src/renderer/src/terminal-liveness'

test('canvas and sidebar terminal presentation names every honest liveness state distinctly', () => {
  assert.deepEqual(terminalLivenessLabels, {
    live: 'Live',
    unverifiable: 'Unverifiable',
    exited: 'Exited'
  })
  assert.match(terminalLivenessDescription('live'), /reports.*live/i)
  assert.match(terminalLivenessDescription('unverifiable'), /cannot.*verify/i)
  assert.match(terminalLivenessDescription('exited'), /confirmed.*exited/i)
})
