import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { activityFromUpdate, activityTitle } from '../src/shared/agent-activity'

test('tool completion patches preserve the descriptive title from the initial event', () => {
  const started = activityFromUpdate({
    sessionUpdate: 'tool_call',
    toolCallId: 'search-1',
    title: 'Searched for the session resume path',
    kind: 'search',
    status: 'in_progress'
  })
  const completed = activityFromUpdate({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'search-1',
    status: 'completed'
  })

  assert.equal(Object.hasOwn(completed, 'title'), false)
  assert.deepEqual({ ...started, ...completed }, {
    id: 'search-1',
    title: 'Searched for the session resume path',
    kind: 'search',
    status: 'completed'
  })
})

test('untitled activities still get a specific worklog summary', () => {
  assert.equal(activityTitle({ id: 'edit-1', kind: 'edit', locations: ['src/main/session.ts'] }), 'Updated src/main/session.ts')
  assert.equal(activityTitle({ id: 'execute-1', kind: 'execute' }), 'Ran a command')
  assert.equal(activityTitle({ id: 'search-1', kind: 'search' }), 'Searched the project')
})
