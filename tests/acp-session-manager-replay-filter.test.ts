import { strict as assert } from 'node:assert'
import { test } from 'vitest'
import { isInternalNotificationText } from '../src/main/acp-session-manager'

// Captured verbatim (session id/paths only) from a real FirstMate session log entry with
// `"type": "user"`, `message.role === "user"`, and `origin.kind === "task-notification"` - the
// exact record shape `replaySessionHistory()` turns into a `user_message_chunk` on resume.
const REAL_STOP_HOOK_FEEDBACK =
  '<task-notification>\n' +
  '<summary>Stop hook feedback</summary>\n' +
  '</task-notification>\n' +
  '<system-reminder>\n' +
  'Stop hook blocking error from command "Stop": firstmate watcher wake - one supervision event ' +
  'needs a handling turn now.\n' +
  'signal: /home/user/.local/share/ade/firstmate/home/state/ade-firstmate-panel-dropdown-overflow.status ' +
  '/home/user/.local/share/ade/firstmate/home/state/ade-firstmate-panel-dropdown-overflow.turn-ended\n' +
  'Run bin/fm-wake-drain.sh first, handle the wake, then run its exact WAKE_ACK_REQUIRED --ack-through ' +
  'command. Until that post-handling acknowledgement, interruption leaves the wake durable for idempotent ' +
  're-handling. This Stop hook owns watcher continuity: when the handling turn ends, the next needed cycle ' +
  'arms automatically - do NOT run bin/fm-watch-arm.sh after an ordinary wake.\n' +
  '\n' +
  '</system-reminder>'

// A task-notification wrapper with no nested system-reminder - also observed in real logs, e.g.
// "Monitor event" / "Background command ... completed" / "Agent ... finished" summaries.
const REAL_BACKGROUND_COMMAND_NOTIFICATION =
  '<task-notification>\n' +
  '<summary>Background command "no-mistakes axi run --intent "reattach" 2&gt;&amp;1" completed (exit code 0)</summary>\n' +
  '</task-notification>'

test('flags a replayed Stop-hook feedback notification (task-notification + system-reminder)', () => {
  assert.equal(isInternalNotificationText(REAL_STOP_HOOK_FEEDBACK), true)
})

test('flags a replayed task-notification with no nested system-reminder', () => {
  assert.equal(isInternalNotificationText(REAL_BACKGROUND_COMMAND_NOTIFICATION), true)
})

test('flags leading-whitespace variants the same way', () => {
  assert.equal(isInternalNotificationText(`\n\n  ${REAL_STOP_HOOK_FEEDBACK}`), true)
})

test('does not flag an ordinary user chat message', () => {
  assert.equal(isInternalNotificationText('Can you add a dark mode toggle to the settings panel?'), false)
})

test('does not flag real assistant/user prose that merely discusses these tags mid-message', () => {
  const text =
    'Sure - internal hooks sometimes emit blocks like <task-notification> or ' +
    '<system-reminder> in the raw log, but the chat view should never show them.'
  assert.equal(isInternalNotificationText(text), false)
})

test('does not flag genuine content that happens to contain the tag name as a substring, not a prefix', () => {
  assert.equal(isInternalNotificationText('The docs mention system-reminder handling further down.'), false)
})
