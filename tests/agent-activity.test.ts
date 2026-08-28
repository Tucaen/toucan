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

test('the tool name, its raw arguments and its diffs survive the ACP mapping', () => {
  const activity = activityFromUpdate({
    sessionUpdate: 'tool_call',
    toolCallId: 'read-1',
    title: 'Read src/main/index.ts',
    kind: 'read',
    status: 'in_progress',
    name: 'Read',
    rawInput: { file_path: '/repo/src/main/index.ts', offset: 10, limit: 5 },
    locations: [{ path: '/repo/src/main/index.ts', line: 10 }]
  })

  assert.equal(activity.toolName, 'Read')
  assert.deepEqual(activity.rawInput, { file_path: '/repo/src/main/index.ts', offset: 10, limit: 5 })

  const edited = activityFromUpdate({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'edit-1',
    status: 'completed',
    content: [{ type: 'diff', path: '/repo/a.ts', oldText: 'before', newText: 'after' }]
  })
  assert.deepEqual(edited.diffs, [{ path: '/repo/a.ts', oldText: 'before', newText: 'after' }])
})

test('the tool name is read from the adapter meta that actually carries it', () => {
  // claude-agent-acp never sets ACP's still-unstable top-level `name`; every notification it
  // builds carries the name in `_meta.claudeCode.toolName` (see its `claudeCodeMetaFromToolUse`).
  const activity = activityFromUpdate({
    sessionUpdate: 'tool_call',
    toolCallId: 'write-1',
    title: 'Write src/a.ts',
    kind: 'edit',
    status: 'pending',
    rawInput: { file_path: '/repo/src/a.ts', content: 'hello' },
    _meta: { claudeCode: { toolName: 'Write' } }
  })
  assert.equal(activity.toolName, 'Write')
})

test('an update that reports no name or arguments leaves the recorded ones alone', () => {
  const patch = activityFromUpdate({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'read-1',
    status: 'completed'
  })
  assert.equal(Object.hasOwn(patch, 'toolName'), false)
  assert.equal(Object.hasOwn(patch, 'rawInput'), false)
  assert.equal(Object.hasOwn(patch, 'diffs'), false)
})

test('untitled activities still get a specific worklog summary', () => {
  assert.equal(activityTitle({ id: 'edit-1', kind: 'edit', locations: ['src/main/session.ts'] }), 'Updated src/main/session.ts')
  assert.equal(activityTitle({ id: 'execute-1', kind: 'execute' }), 'Ran a command')
  assert.equal(activityTitle({ id: 'search-1', kind: 'search' }), 'Searched the project')
})
