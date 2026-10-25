import { strict as assert } from 'node:assert'
import { test } from 'vitest'
import type { AgentActivity, AgentEvent } from '../src/shared/agent'
import { foldAgentEvent, initialAgentTranscriptState } from '../src/shared/agent-transcript'
import {
  parseRemoteChatClientMessage,
  parseRemoteChatServerMessage,
  REMOTE_CHAT_ACTIVITY_ID_LIMIT
} from '../src/shared/remote-chat'
import {
  REMOTE_ACTIVITY_LOCATION_LIMIT,
  REMOTE_ACTIVITY_PREVIEW_LIMIT,
  REMOTE_ACTIVITY_TITLE_LIMIT,
  slimActivity,
  slimAgentEvent,
  slimTranscriptState
} from '../src/shared/remote-activity'

/**
 * What the phone is sent of a tool call. The point of the module is a byte budget, so most of these
 * assert what is *absent*: a body that rides along by omission is the bug this exists to prevent.
 */

const NOW = 1_700_000_000_000

const HEAVY: AgentActivity = {
  id: 'call-1',
  title: 'Edit src/app.ts',
  kind: 'edit',
  status: 'completed',
  toolName: 'Edit',
  locations: ['D:/work/src/app.ts'],
  content: 'Changed D:/work/src/app.ts',
  rawInput: { file_path: 'D:/work/src/app.ts', old_string: 'x'.repeat(5_000), new_string: 'y'.repeat(5_000) },
  rawOutput: { structuredPatch: 'z'.repeat(5_000) },
  diffs: [{ path: 'D:/work/src/app.ts', oldText: 'x'.repeat(5_000), newText: 'y'.repeat(5_000) }],
  images: [{ id: 'call-1#0', data: 'A'.repeat(5_000), mimeType: 'image/png' }],
  terminalOutput: 'o'.repeat(5_000),
  delegationEvidence: { requestedModel: 'sonnet', observedStatuses: ['completed'] },
  startedAt: NOW,
  endedAt: NOW + 40
}

const BODY_FIELDS = ['content', 'rawInput', 'rawOutput', 'diffs', 'images', 'terminalChunk', 'terminalOutput'] as const

test('a slim activity keeps what a card header is made of and none of what is behind it', () => {
  const slim = slimActivity(HEAVY)

  for (const field of BODY_FIELDS) assert.equal(field in slim, false, `${field} must not be sent`)
  assert.equal('delegationEvidence' in slim, false)
  assert.equal(slim.id, 'call-1')
  assert.equal(slim.title, 'Edit src/app.ts')
  assert.equal(slim.kind, 'edit')
  assert.equal(slim.status, 'completed')
  assert.equal(slim.toolName, 'Edit')
  assert.deepEqual(slim.locations, ['D:/work/src/app.ts'])
  assert.equal(slim.startedAt, NOW)
  assert.equal(slim.endedAt, NOW + 40)
  assert.ok(JSON.stringify(slim).length < 600, `slim copy is ${JSON.stringify(slim).length} bytes`)
})

test('slimming never alters the activity the host keeps', () => {
  const before = JSON.stringify(HEAVY)
  slimActivity(HEAVY)
  assert.equal(JSON.stringify(HEAVY), before)
})

test('the exit status and the delegation markers are not body: they stay', () => {
  const slim = slimActivity({
    id: 'sh-1',
    kind: 'execute',
    status: 'failed',
    exitCode: 2,
    exitSignal: 'SIGTERM',
    terminalCwd: 'D:/work',
    parentToolCallId: 'task-1',
    subagent: true
  })
  assert.equal(slim.exitCode, 2)
  assert.equal(slim.exitSignal, 'SIGTERM')
  assert.equal(slim.terminalCwd, 'D:/work')
  assert.equal(slim.parentToolCallId, 'task-1')
  assert.equal(slim.subagent, true)
})

test('a patch that carried no title stays without one, so it cannot blank the title it patches', () => {
  const slim = slimActivity({ id: 'call-1', status: 'completed' })
  assert.deepEqual(slim, { id: 'call-1', status: 'completed' })
  assert.equal('title' in slim, false)
  assert.equal('preview' in slim, false)
})

test('a command previews its last output, a read previews its start, a diff previews the new text', () => {
  const output = `${'noise\n'.repeat(400)}the last line`
  const command = slimActivity({ id: 'a', kind: 'execute', terminalOutput: output })
  assert.ok(command.preview?.endsWith('the last line'), command.preview)
  assert.ok(command.preview!.length <= REMOTE_ACTIVITY_PREVIEW_LIMIT)

  const read = slimActivity({ id: 'b', kind: 'read', content: `first line\n${'body\n'.repeat(400)}` })
  assert.ok(read.preview?.startsWith('first line'), read.preview)
  assert.ok(read.preview!.length <= REMOTE_ACTIVITY_PREVIEW_LIMIT)

  const edit = slimActivity({
    id: 'c',
    kind: 'edit',
    diffs: [{ path: 'a.ts', oldText: 'old', newText: 'const next = 1' }]
  })
  assert.equal(edit.preview, 'const next = 1')
})

test('a streamed chunk previews itself, and a preview is a single line', () => {
  const slim = slimActivity({ id: 'a', kind: 'execute', terminalChunk: 'one\n\n  two\tthree\n' })
  assert.equal(slim.preview, 'one two three')
})

test('a long title and a long location list are clipped to what a summary line reads', () => {
  const slim = slimActivity({
    id: 'a',
    title: `Run ${'x'.repeat(2_000)}`,
    locations: Array.from({ length: 50 }, (_, index) => `file-${index}.ts`)
  })
  assert.ok(slim.title!.length <= REMOTE_ACTIVITY_TITLE_LIMIT)
  assert.ok(slim.title!.endsWith('…'))
  assert.equal(slim.locations?.length, REMOTE_ACTIVITY_LOCATION_LIMIT)
  assert.equal(slim.locations?.[0], 'file-0.ts')
})

test('only activities are cut down on the tail; an approval keeps its request but loses the call body', () => {
  const message: AgentEvent = { type: 'message', role: 'assistant', messageId: 'm', text: 'hi' }
  assert.equal(slimAgentEvent(message), message, 'every other event travels verbatim')

  const activity = slimAgentEvent({ type: 'activity', activity: HEAVY })
  assert.equal(activity.type === 'activity' && 'diffs' in activity.activity, false)

  const approval = slimAgentEvent({
    type: 'approval',
    approvalId: 'ap-1',
    title: 'Allow edit?',
    options: [{ id: 'allow', label: 'Allow', kind: 'allow_once' }],
    activity: HEAVY
  })
  assert.equal(approval.type, 'approval')
  if (approval.type === 'approval') {
    assert.equal(approval.approvalId, 'ap-1')
    assert.equal(approval.options[0]?.id, 'allow')
    assert.equal(approval.activity?.title, 'Edit src/app.ts')
    assert.equal(approval.activity && 'rawInput' in approval.activity, false)
  }
})

test('a snapshot slims every activity and the approval, and nothing else about it moves', () => {
  let state = initialAgentTranscriptState()
  const events: AgentEvent[] = [
    { type: 'message', role: 'user', messageId: 'u1', text: 'edit it' },
    { type: 'activity', activity: HEAVY },
    { type: 'approval', approvalId: 'ap-1', title: 'Allow?', options: [], activity: { ...HEAVY, id: 'call-2' } },
    { type: 'status', status: 'working' }
  ]
  for (const event of events) state = foldAgentEvent(state, event, NOW)

  const slim = slimTranscriptState(state)
  assert.deepEqual(slim.messages, state.messages)
  assert.deepEqual(slim.transcript, state.transcript)
  assert.equal(slim.status, 'working')
  assert.equal(slim.approval?.id, 'ap-1')
  for (const activity of Object.values(slim.activities)) assert.equal('diffs' in activity, false)
  assert.equal(slim.approval?.activity && 'diffs' in slim.approval.activity, false)
  assert.ok(state.activities['call-1']?.diffs, 'the host copy still has its body')
  assert.ok(state.approval?.activity?.diffs, 'and so does its pending approval')
  assert.ok(JSON.stringify(slim).length < JSON.stringify(state).length / 5)
})

test('slim patches fold on the phone to the same card the host holds, minus the body', () => {
  // The phone runs the same reducer over slim events; a status patch with no title must not blank
  // the title an earlier slim event set, exactly as on the host.
  const events: AgentEvent[] = [
    { type: 'activity', activity: { id: 'c', title: 'Run tests', kind: 'execute', status: 'in_progress' } },
    { type: 'activity', activity: { id: 'c', terminalChunk: 'PASS a\nPASS b\n' } },
    { type: 'activity', activity: { id: 'c', status: 'completed', exitCode: 0 } }
  ]
  let host = initialAgentTranscriptState()
  let phone = initialAgentTranscriptState()
  for (const event of events) {
    host = foldAgentEvent(host, event, NOW)
    phone = foldAgentEvent(phone, slimAgentEvent(event), NOW)
  }
  const card = phone.activities.c!
  assert.equal(card.title, 'Run tests')
  assert.equal(card.status, 'completed')
  assert.equal(card.exitCode, 0)
  assert.equal(card.preview, 'PASS a PASS b')
  assert.equal(card.terminalOutput, undefined)
  assert.equal(host.activities.c?.terminalOutput, 'PASS a\nPASS b\n')
})

test('the activity request is validated strictly on the host and parsed leniently on the phone', () => {
  assert.deepEqual(
    parseRemoteChatClientMessage(JSON.stringify({ type: 'activity', requestId: 'r1', activityId: 'call-1' })),
    { type: 'activity', requestId: 'r1', activityId: 'call-1' }
  )
  for (const bad of [
    { type: 'activity', requestId: 'r1' },
    { type: 'activity', requestId: 'r1', activityId: '' },
    { type: 'activity', requestId: 'r1', activityId: 7 },
    { type: 'activity', requestId: 'r1', activityId: 'x'.repeat(REMOTE_CHAT_ACTIVITY_ID_LIMIT + 1) },
    { type: 'activity', activityId: 'call-1' }
  ]) {
    assert.equal(parseRemoteChatClientMessage(JSON.stringify(bad)), null, JSON.stringify(bad))
  }

  assert.deepEqual(
    parseRemoteChatServerMessage(
      JSON.stringify({ type: 'activity_result', requestId: 'r1', ok: true, activity: { id: 'call-1' } })
    ),
    { type: 'activity_result', requestId: 'r1', ok: true, activity: { id: 'call-1' } }
  )
  assert.deepEqual(
    parseRemoteChatServerMessage(
      JSON.stringify({ type: 'activity_result', requestId: 'r1', ok: false, message: 'gone' })
    ),
    { type: 'activity_result', requestId: 'r1', ok: false, message: 'gone' }
  )
  assert.equal(parseRemoteChatServerMessage(JSON.stringify({ type: 'activity_result', ok: true })), null)
})
