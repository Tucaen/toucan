import { strict as assert } from 'node:assert'
import { test } from 'vitest'
import type { AvailableCommand } from '@agentclientprotocol/sdk'
import { simplifyAvailableCommands } from '../src/main/acp-session-manager'

// The composer's completion renders whatever the session advertises, so what crosses the IPC
// boundary has to be narrowed to exactly the fields it draws - and never contain a row that
// can't be inserted.

/** An entry as a real adapter might emit it, including shapes the protocol type forbids. */
const advertised = (command: unknown): AvailableCommand => command as AvailableCommand

test('keeps the name, description and argument hint of each advertised command', () => {
  assert.deepEqual(
    simplifyAvailableCommands([
      advertised({ name: 'review', description: 'Review the changes' }),
      advertised({ name: 'commit', description: 'Commit staged work', input: { hint: '[message]' } })
    ]),
    [
      { name: 'review', description: 'Review the changes' },
      { name: 'commit', description: 'Commit staged work', input: { hint: '[message]' } }
    ]
  )
})

test('a command without a description still lists, with empty description text', () => {
  assert.deepEqual(simplifyAvailableCommands([advertised({ name: 'compact', description: null })]), [
    { name: 'compact', description: '' }
  ])
})

test('an unnamed command is dropped rather than rendered as an uninsertable row', () => {
  assert.deepEqual(simplifyAvailableCommands([advertised({ name: '', description: 'nameless' })]), [])
})

test('an agent that advertises nothing yields an empty list', () => {
  assert.deepEqual(simplifyAvailableCommands(undefined), [])
  assert.deepEqual(simplifyAvailableCommands(null), [])
  assert.deepEqual(simplifyAvailableCommands([]), [])
})
