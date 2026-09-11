import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  isProjectRunCommand,
  moveRunCommand,
  normalizeRunCommands,
  runCommandsIncomplete,
  type ProjectRunCommand
} from '../src/shared/project-run-commands'

function entry(overrides: Partial<ProjectRunCommand> = {}): ProjectRunCommand {
  return { id: 'a', name: 'Web', command: 'npm run dev', ...overrides }
}

test('saving a draft list trims both fields and keeps the order the user arranged', () => {
  const drafts = [entry({ id: 'a', name: '  Web  ', command: '  npm run dev  ' }), entry({ id: 'b', name: 'API' })]

  assert.deepEqual(normalizeRunCommands(drafts), [
    { id: 'a', name: 'Web', command: 'npm run dev' },
    { id: 'b', name: 'API', command: 'npm run dev' }
  ])
})

test('a row the user never filled in is scratch and is dropped, so an unused Add costs nothing', () => {
  const drafts = [entry(), entry({ id: 'blank', name: '   ', command: '' })]

  assert.deepEqual(normalizeRunCommands(drafts), [entry()])
  assert.equal(runCommandsIncomplete(drafts), false)
})

test('a half-filled row survives normalization and is reported instead, never silently discarded', () => {
  const named = [entry({ id: 'half', name: 'API', command: '  ' })]
  const unnamed = [entry({ id: 'half', name: '', command: 'npm run api' })]

  assert.equal(runCommandsIncomplete(named), true)
  assert.equal(runCommandsIncomplete(unnamed), true)
  assert.equal(normalizeRunCommands(named).length, 1)
  assert.equal(normalizeRunCommands(unnamed).length, 1)
})

test('an empty list is complete and normalizes to nothing', () => {
  assert.deepEqual(normalizeRunCommands([]), [])
  assert.equal(runCommandsIncomplete([]), false)
})

test('a row moves one place at a time and the ends are walls rather than a wrap', () => {
  const list = [entry({ id: 'a' }), entry({ id: 'b' }), entry({ id: 'c' })]

  assert.deepEqual(
    moveRunCommand(list, 2, -1).map((item) => item.id),
    ['a', 'c', 'b']
  )
  assert.deepEqual(
    moveRunCommand(list, 0, 1).map((item) => item.id),
    ['b', 'a', 'c']
  )
  assert.equal(moveRunCommand(list, 0, -1), list)
  assert.equal(moveRunCommand(list, 2, 1), list)
  assert.equal(moveRunCommand(list, 7, 1), list)
})

test('what counts as a stored command is exactly three strings', () => {
  assert.equal(isProjectRunCommand(entry()), true)
  assert.equal(isProjectRunCommand({ id: 'a', name: 'Web' }), false)
  assert.equal(isProjectRunCommand({ id: 1, name: 'Web', command: 'x' }), false)
  assert.equal(isProjectRunCommand(null), false)
  assert.equal(isProjectRunCommand('npm run dev'), false)
})
