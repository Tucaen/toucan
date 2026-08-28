import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  acceptSlashCommand,
  acceptedSlashCompletion,
  dismissSlashCompletion,
  emptySlashCompletion,
  filterSlashCommands,
  highlightSlashCommand,
  moveSlashSelection,
  slashCompletionQuery,
  slashCompletionView
} from '../src/renderer/src/slash-command-completion'
import type { AgentCommand } from '../src/shared/agent'

const commands: AgentCommand[] = [
  { name: 'review', description: 'Review the changes' },
  { name: 'commit', description: 'Commit staged work', input: { hint: '[message]' } },
  { name: 'compact', description: 'Compact the conversation' },
  { name: 'mcp:deploy', description: 'Deploy via MCP' }
]

test('a slash at the start of an empty composer opens the completion with an empty query', () => {
  assert.deepEqual(slashCompletionQuery('/', 1), { query: '', start: 0 })
})

test('the query is everything typed after the slash up to the caret', () => {
  assert.deepEqual(slashCompletionQuery('/rev', 4), { query: 'rev', start: 0 })
})

test('a caret parked inside the token still completes the part before it', () => {
  assert.deepEqual(slashCompletionQuery('/review', 3), { query: 're', start: 0 })
})

test('a slash that is not the first thing on its line is ordinary text', () => {
  assert.equal(slashCompletionQuery('see src/main', 12), null)
  assert.equal(slashCompletionQuery('ask /review', 11), null)
})

test('a slash opening a later line completes too', () => {
  const draft = 'first line\n/rev'
  assert.deepEqual(slashCompletionQuery(draft, draft.length), { query: 'rev', start: 11 })
})

test('leading whitespace before the slash is tolerated', () => {
  assert.deepEqual(slashCompletionQuery('  /rev', 6), { query: 'rev', start: 2 })
})

test('once arguments are being typed the completion is closed', () => {
  assert.equal(slashCompletionQuery('/commit fix the build', 21), null)
})

test('a composer with no slash at all never completes', () => {
  assert.equal(slashCompletionQuery('', 0), null)
  assert.equal(slashCompletionQuery('hello', 5), null)
})

test('an empty query lists every command in advertised order', () => {
  assert.deepEqual(filterSlashCommands(commands, '').map((command) => command.name), [
    'review',
    'commit',
    'compact',
    'mcp:deploy'
  ])
})

test('typing narrows the list, prefix matches ranking above interior ones', () => {
  assert.deepEqual(filterSlashCommands(commands, 'co').map((command) => command.name), ['commit', 'compact'])
  assert.deepEqual(filterSlashCommands(commands, 'ep').map((command) => command.name), ['mcp:deploy'])
})

test('matching ignores case', () => {
  assert.deepEqual(filterSlashCommands(commands, 'REV').map((command) => command.name), ['review'])
})

test('a query nothing matches yields an empty list', () => {
  assert.deepEqual(filterSlashCommands(commands, 'zzz'), [])
})

test('accepting an argument-free command replaces the token and leaves the caret after it', () => {
  const result = acceptSlashCommand('/rev', 4, { start: 0 }, commands[0])
  assert.deepEqual(result, { draft: '/review', caret: 7 })
})

test('accepting a command that takes arguments leaves the caret positioned to type them', () => {
  const result = acceptSlashCommand('/com', 4, { start: 0 }, commands[1])
  assert.deepEqual(result, { draft: '/commit ', caret: 8 })
})

test('accepting keeps whatever already followed the caret', () => {
  const result = acceptSlashCommand('/rev the diff', 4, { start: 0 }, commands[0])
  assert.deepEqual(result, { draft: '/review the diff', caret: 7 })
})

test('accepting on a later line only rewrites that line’s token', () => {
  const draft = 'context\n/com'
  const result = acceptSlashCommand(draft, draft.length, { start: 8 }, commands[1])
  assert.deepEqual(result, { draft: 'context\n/commit ', caret: 16 })
})

test('selection wraps around both ends of the list', () => {
  assert.equal(moveSlashSelection(0, 3, 1), 1)
  assert.equal(moveSlashSelection(2, 3, 1), 0)
  assert.equal(moveSlashSelection(0, 3, -1), 2)
  assert.equal(moveSlashSelection(5, 3, 1), 0)
  assert.equal(moveSlashSelection(0, 0, 1), 0)
})

test('the view opens on a slash token that matches something', () => {
  const view = slashCompletionView('/re', 3, commands, emptySlashCompletion)
  assert.equal(view.open, true)
  assert.deepEqual(view.token, { query: 're', start: 0 })
  assert.deepEqual(view.matches.map((command) => command.name), ['review'])
  assert.equal(view.activeIndex, 0)
})

test('the view stays closed when nothing matches, or when there is no token at all', () => {
  assert.equal(slashCompletionView('/zzz', 4, commands, emptySlashCompletion).open, false)
  assert.equal(slashCompletionView('hello', 5, commands, emptySlashCompletion).open, false)
})

test('an agent that advertises nothing never opens the view', () => {
  assert.equal(slashCompletionView('/', 1, [], emptySlashCompletion).open, false)
})

test('a highlight left over from a longer list is clamped into the narrowed one', () => {
  const state = highlightSlashCommand(emptySlashCompletion, 3)
  assert.equal(slashCompletionView('/re', 3, commands, state).activeIndex, 0)
})

test('dismissing closes the view for that token, and typing on keeps it closed', () => {
  const opened = slashCompletionView('/co', 3, commands, emptySlashCompletion)
  const dismissed = dismissSlashCompletion(emptySlashCompletion, opened.token)

  assert.equal(slashCompletionView('/co', 3, commands, dismissed).open, false)
  assert.equal(slashCompletionView('/com', 4, commands, dismissed).open, false)
})

test('a dismissal is spent once the draft has no slash token left, so the next one still completes', () => {
  const opened = slashCompletionView('/co', 3, commands, emptySlashCompletion)
  const dismissed = dismissSlashCompletion(emptySlashCompletion, opened.token)

  // What the composer does when the token disappears (sent, cleared, edited away).
  assert.equal(slashCompletionView('', 0, commands, dismissed).token, null)
  assert.equal(slashCompletionView('/co', 3, commands, emptySlashCompletion).open, true)
})

test('the just-accepted command does not sit open over the choice that was made', () => {
  const accepted = acceptedSlashCompletion(emptySlashCompletion, commands[0])
  assert.equal(slashCompletionView('/review', 7, commands, accepted).open, false)
})

test('editing an accepted token offers the list right back', () => {
  const accepted = acceptedSlashCompletion(emptySlashCompletion, commands[0])
  assert.equal(slashCompletionView('/revie', 6, commands, accepted).open, true)
})

test('accepting clears any earlier dismissal rather than compounding with it', () => {
  const dismissed = dismissSlashCompletion(emptySlashCompletion, { query: 'co', start: 0 })
  assert.equal(acceptedSlashCompletion(dismissed, commands[1]).dismissedStart, null)
})
