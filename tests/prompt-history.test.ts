import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  PROMPT_HISTORY_LIMIT,
  emptyPromptHistory,
  leaveHistory,
  recallNext,
  recallPrevious,
  rememberPrompt,
  seedPromptHistory
} from '../src/renderer/src/prompt-history'

test('walking back from an empty history leaves the draft alone', () => {
  const { state, draft } = recallPrevious(emptyPromptHistory, 'typing')
  assert.equal(draft, 'typing')
  assert.equal(state, emptyPromptHistory)
})

test('ArrowUp walks back through sent prompts newest first, and ArrowDown walks forward again', () => {
  const history = rememberPrompt(rememberPrompt(emptyPromptHistory, 'first'), 'second')

  const back1 = recallPrevious(history, '')
  assert.equal(back1.draft, 'second')
  const back2 = recallPrevious(back1.state, back1.draft)
  assert.equal(back2.draft, 'first')

  const forward = recallNext(back2.state)
  assert.equal(forward.draft, 'second')
  assert.equal(recallNext(forward.state).draft, '')
})

test('walking back past the oldest prompt stays on it rather than wrapping around', () => {
  const history = rememberPrompt(emptyPromptHistory, 'only')
  const first = recallPrevious(history, '')
  const again = recallPrevious(first.state, first.draft)
  assert.equal(again.draft, 'only')
})

test('a half-typed draft is stashed on entry and restored on the way back out', () => {
  const history = rememberPrompt(emptyPromptHistory, 'sent earlier')
  const back = recallPrevious(history, 'half typed')
  assert.equal(back.draft, 'sent earlier')
  const forward = recallNext(back.state)
  assert.equal(forward.draft, 'half typed')
  assert.equal(forward.state.index, null)
})

test('leaveHistory drops the navigation cursor without touching the entries', () => {
  const history = recallPrevious(rememberPrompt(emptyPromptHistory, 'sent'), '').state
  const left = leaveHistory(history)
  assert.equal(left.index, null)
  assert.deepEqual(left.entries, ['sent'])
})

test('remembering ignores blank prompts and collapses an immediate repeat', () => {
  let history = rememberPrompt(emptyPromptHistory, '   ')
  assert.deepEqual(history.entries, [])
  history = rememberPrompt(rememberPrompt(history, 'same'), 'same')
  assert.deepEqual(history.entries, ['same'])
})

test('remembering resets any in-progress navigation, so the next ArrowUp starts from the newest prompt', () => {
  const walking = recallPrevious(rememberPrompt(emptyPromptHistory, 'older'), '').state
  const after = rememberPrompt(walking, 'newest')
  assert.equal(after.index, null)
  assert.equal(recallPrevious(after, '').draft, 'newest')
})

test('history is bounded so a long session cannot grow it without limit', () => {
  let history = emptyPromptHistory
  for (let n = 0; n <= PROMPT_HISTORY_LIMIT + 5; n += 1) history = rememberPrompt(history, `prompt ${n}`)
  assert.equal(history.entries.length, PROMPT_HISTORY_LIMIT)
  assert.equal(history.entries.at(-1), `prompt ${PROMPT_HISTORY_LIMIT + 5}`)
  assert.equal(history.entries[0], 'prompt 6')
})

test('a resumed conversation seeds its history from the prompts the transcript already shows', () => {
  const seeded = seedPromptHistory(emptyPromptHistory, ['asked first', 'asked second'])
  assert.deepEqual(seeded.entries, ['asked first', 'asked second'])
  assert.equal(recallPrevious(seeded, '').draft, 'asked second')
})

test('seeding is a one-shot: a history with entries of its own is never re-seeded into duplicates', () => {
  const own = rememberPrompt(emptyPromptHistory, 'typed here')
  assert.equal(seedPromptHistory(own, ['typed here', 'and more']), own)
})
