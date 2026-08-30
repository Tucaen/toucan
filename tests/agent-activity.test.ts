import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { activityFromUpdate, activityTitle, mergeActivity } from '../src/shared/agent-activity'

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

test('a permission tool-call update can use the same mapping as transcript activity', () => {
  const activity = activityFromUpdate({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'permission-edit',
    kind: 'edit',
    content: [
      { type: 'diff', path: '/repo/a.ts', oldText: 'one', newText: 'two' },
      { type: 'diff', path: '/repo/b.ts', oldText: 'three', newText: 'four' }
    ]
  })
  assert.deepEqual(activity.diffs, [
    { path: '/repo/a.ts', oldText: 'one', newText: 'two' },
    { path: '/repo/b.ts', oldText: 'three', newText: 'four' }
  ])
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

test("a Bash result's output and exit code are read out of the terminal meta channel", () => {
  // claude-agent-acp sends a Bash call's output as one `terminal_output` and its exit as
  // `terminal_exit`, and its ACP content is only a placeholder pointing at that channel.
  const output = activityFromUpdate({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'bash-1',
    content: [{ type: 'terminal', terminalId: 'bash-1' }],
    _meta: { terminal_output: { terminal_id: 'bash-1', data: '2 failing\n' } }
  })
  assert.equal(output.terminalChunk, '2 failing\n')

  const exited = activityFromUpdate({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'bash-1',
    status: 'failed',
    _meta: { terminal_exit: { terminal_id: 'bash-1', exit_code: 1, signal: null } }
  })
  assert.equal(exited.exitCode, 1)
  assert.equal(Object.hasOwn(exited, 'exitSignal'), false)
})

test("a Codex command reports its exit code structurally, and its cwd on the call that starts it", () => {
  const started = activityFromUpdate({
    sessionUpdate: 'tool_call',
    toolCallId: 'cmd-1',
    kind: 'execute',
    title: 'npm run lint',
    status: 'in_progress',
    rawInput: { command: 'npm run lint', cwd: '/repo/sub' },
    _meta: { terminal_info: { terminal_id: 'cmd-1', cwd: '/repo/sub' } }
  })
  assert.equal(started.terminalCwd, '/repo/sub')

  const finished = activityFromUpdate({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'cmd-1',
    status: 'failed',
    rawOutput: { formatted_output: 'nope\n', exit_code: 2 }
  })
  assert.equal(finished.exitCode, 2)
  assert.deepEqual(finished.rawOutput, { formatted_output: 'nope\n', exit_code: 2 })
})

test('streamed terminal chunks accumulate instead of replacing each other', () => {
  // codex-acp emits one meta per chunk while the command runs, and claude-agent-acp emits the
  // whole output as a single chunk, so appending is the reading that is right for both.
  const first = mergeActivity(undefined, activityFromUpdate({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'cmd-1',
    _meta: { terminal_output_delta: { terminal_id: 'cmd-1', data: 'compiling\n' } }
  }), 1000)
  const second = mergeActivity(first, activityFromUpdate({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'cmd-1',
    _meta: { terminal_output_delta: { terminal_id: 'cmd-1', data: 'done\n' } }
  }), 1100)
  assert.equal(second.terminalOutput, 'compiling\ndone\n')
  // The chunk is consumed, so re-folding the same object can never double the output.
  assert.equal(second.terminalChunk, undefined)
  assert.equal(mergeActivity(second, second, 1200).terminalOutput, 'compiling\ndone\n')

  // An update that carries no output at all leaves what the call already produced alone.
  const settled = mergeActivity(second, activityFromUpdate({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'cmd-1',
    status: 'completed'
  }), 1200)
  assert.equal(settled.terminalOutput, 'compiling\ndone\n')
  assert.equal(settled.endedAt, 1200)
})

test('untitled activities still get a specific worklog summary', () => {
  assert.equal(activityTitle({ id: 'edit-1', kind: 'edit', locations: ['src/main/session.ts'] }), 'Updated src/main/session.ts')
  assert.equal(activityTitle({ id: 'execute-1', kind: 'execute' }), 'Ran a command')
  assert.equal(activityTitle({ id: 'search-1', kind: 'search' }), 'Searched the project')
})

test('a subagent tool call carries its parent, and the spawning call is marked a delegation', () => {
  const spawn = activityFromUpdate({
    sessionUpdate: 'tool_call',
    toolCallId: 'task-1',
    title: 'Task',
    kind: 'other',
    status: 'in_progress',
    rawInput: { subagent_type: 'Explore', description: 'Find the plan rail' },
    _meta: { claudeCode: { toolName: 'Task', subagent: true } }
  })
  const child = activityFromUpdate({
    sessionUpdate: 'tool_call',
    toolCallId: 'grep-9',
    title: 'Grep',
    kind: 'search',
    status: 'in_progress',
    _meta: { claudeCode: { toolName: 'Grep', parentToolUseId: 'task-1' } }
  })

  assert.equal(spawn.subagent, true)
  assert.equal(spawn.parentToolCallId, undefined)
  assert.equal(child.parentToolCallId, 'task-1')
  assert.equal(child.subagent, undefined)
})

test('a codex subagent activity is recognized as a delegation from its own meta', () => {
  const activity = activityFromUpdate({
    sessionUpdate: 'tool_call',
    toolCallId: 'sub-1',
    title: 'Subagent reviewer',
    kind: 'other',
    status: 'in_progress',
    rawInput: { agentPath: '.codex/agents/reviewer.md', activityKind: 'started' },
    _meta: { codex: { subagent: { threadId: 't1', path: '.codex/agents/reviewer.md' } } }
  })

  assert.equal(activity.subagent, true)
})

test('an update with no delegation meta neither sets nor blanks what an earlier one recorded', () => {
  const started = activityFromUpdate({
    sessionUpdate: 'tool_call',
    toolCallId: 'task-1',
    title: 'Task',
    status: 'in_progress',
    _meta: { claudeCode: { toolName: 'Task', subagent: true } }
  })
  const completed = activityFromUpdate({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'task-1',
    status: 'completed'
  })

  assert.equal(Object.hasOwn(completed, 'subagent'), false)
  assert.equal(mergeActivity(started, completed, 100).subagent, true)
})
