import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { mergeActivity } from '../src/shared/agent-activity'
import {
  defaultToolCardExpanded,
  formatToolDuration,
  resolveToolCardExpanded,
  toolCardElapsed,
  truncateToolOutput
} from '../src/renderer/src/tool-card'

test('a running call is expanded, a completed one folds away, a failure stays open', () => {
  assert.equal(defaultToolCardExpanded('pending'), true)
  assert.equal(defaultToolCardExpanded('in_progress'), true)
  assert.equal(defaultToolCardExpanded(undefined), true)
  assert.equal(defaultToolCardExpanded('completed'), false)
  assert.equal(defaultToolCardExpanded('failed'), true)
})

test('the reader\'s own toggle outranks the status default', () => {
  assert.equal(resolveToolCardExpanded('completed', { expanded: true, status: 'completed' }), true)
  assert.equal(resolveToolCardExpanded('in_progress', { expanded: false, status: 'in_progress' }), false)
  assert.equal(resolveToolCardExpanded('in_progress', undefined), true)
})

test('a card collapsed while it was working re-opens itself when the call then fails', () => {
  assert.equal(resolveToolCardExpanded('failed', { expanded: false, status: 'in_progress' }), true)
  // ...but the reader may still close it once they have seen the failure.
  assert.equal(resolveToolCardExpanded('failed', { expanded: false, status: 'failed' }), false)
})

test('durations read at a glance rather than in raw milliseconds', () => {
  assert.equal(formatToolDuration(undefined), undefined)
  assert.equal(formatToolDuration(-5), '0.0s')
  assert.equal(formatToolDuration(420), '0.4s')
  assert.equal(formatToolDuration(9_949), '9.9s')
  assert.equal(formatToolDuration(12_400), '12s')
  assert.equal(formatToolDuration(65_000), '1m 05s')
  assert.equal(formatToolDuration(3_725_000), '62m 05s')
})

test('elapsed runs to now while working and freezes at the recorded end', () => {
  assert.equal(toolCardElapsed({ id: 'a', startedAt: 1_000, status: 'in_progress' }, 4_000), 3_000)
  assert.equal(toolCardElapsed({ id: 'a', startedAt: 1_000, endedAt: 2_500, status: 'completed' }, 9_000), 1_500)
  assert.equal(toolCardElapsed({ id: 'a' }, 9_000), undefined)
})

test('output is clamped to a bounded number of lines with the remainder counted, not dropped silently', () => {
  const huge = Array.from({ length: 5000 }, (_, index) => `line ${index}`).join('\n')
  const clamped = truncateToolOutput(huge, 40)
  assert.equal(clamped.text.split('\n').length, 40)
  assert.equal(clamped.hiddenLines, 4960)

  const small = truncateToolOutput('one\ntwo', 40)
  assert.deepEqual(small, { text: 'one\ntwo', hiddenLines: 0 })
  assert.deepEqual(truncateToolOutput(undefined, 40), { text: '', hiddenLines: 0 })
})

test('activity merges stamp a start once and freeze an end when the call settles', () => {
  const started = mergeActivity(undefined, { id: 'x', title: 'Ran a command', status: 'in_progress' }, 1_000)
  assert.equal(started.startedAt, 1_000)
  assert.equal(started.endedAt, undefined)

  const stillRunning = mergeActivity(started, { id: 'x', status: 'in_progress' }, 2_000)
  assert.equal(stillRunning.startedAt, 1_000)

  const done = mergeActivity(stillRunning, { id: 'x', status: 'completed' }, 3_500)
  assert.equal(done.startedAt, 1_000)
  assert.equal(done.endedAt, 3_500)
  assert.equal(done.title, 'Ran a command')

  const lateEcho = mergeActivity(done, { id: 'x', content: 'output' }, 9_000)
  assert.equal(lateEcho.endedAt, 3_500)
})

test('a call that resumes after a terminal status starts timing again instead of showing a stale duration', () => {
  const done = mergeActivity({ id: 'x', status: 'completed', startedAt: 1_000, endedAt: 2_000 }, { id: 'x', status: 'in_progress' }, 5_000)
  assert.equal(done.endedAt, undefined)
  assert.equal(done.startedAt, 1_000)
})
