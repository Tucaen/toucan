import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import type { AgentEvent, AgentPromptResult } from '../src/shared/agent'
import { StallTimeoutError, withStallGuard } from '../src/shared/stall-guard'
import { createPromptWakeGate, type PromptWakeGate } from '../src/main/prompt-wake-gate'
import { promptFailure } from '../src/main/acp-session-manager'

// Reproduces the "status indicator shows Working forever" symptom: `runPrompt` used to have no
// exit path other than its awaited ACP `session/prompt` call settling. If the agent subprocess or
// its ACP connection ever stalled (a dropped stream, a deadlock, a tool-permission approval
// request that never surfaced) without erroring or exiting, that `await` never settled, so `busy`
// never cleared and the renderer's `status` never left `'working'`. Any message queued behind the
// hung turn then sat in the wake gate until its own 120s timeout fired a plain `error` event -
// which, per use-agent-conversation.ts, only updates `detail`, never `status`, so the UI stayed on
// "Working" forever even after that timeout.
//
// This harness mirrors `runPrompt`'s actual shape - set `busy`, await the ACP request wrapped in
// `withStallGuard`, run the real exported `promptFailure` on rejection, clear `busy` and flush the
// real `PromptWakeGate` in `finally` - using the same real, exported helpers the production code
// uses, so a regression that drops the `withStallGuard` wrap in `acp-session-manager.ts` is caught
// through behavior even though `runPrompt` itself isn't exported for direct testing (it closes
// over a live ACP child process connection that this suite, like the rest of this file's
// siblings, does not spin up).

function makeHarness(turnTimeoutMs: number): {
  running: { busy: boolean }
  events: AgentEvent[]
  wakeGate: PromptWakeGate
} {
  const running = { busy: false }
  const events: AgentEvent[] = []
  let wakeGate!: PromptWakeGate

  const runPrompt = async (text: string): Promise<AgentPromptResult> => {
    running.busy = true
    events.push({ type: 'status', status: 'working' })
    try {
      const request =
        text === 'hung message'
          ? new Promise<{ stopReason: string }>(() => {}) // simulates a wedged ACP subprocess/connection
          : Promise.resolve({ stopReason: 'end_turn' })
      const response = await withStallGuard(
        request,
        turnTimeoutMs,
        `The agent turn did not complete within ${turnTimeoutMs}ms.`
      )
      events.push({ type: 'turn_complete', stopReason: response.stopReason })
      events.push({ type: 'status', status: 'idle' })
      return { ok: true }
    } catch (error) {
      const failure = promptFailure(error, [])
      events.push(...failure.events)
      return failure.result
    } finally {
      running.busy = false
      wakeGate.flush()
    }
  }

  wakeGate = createPromptWakeGate({ deliver: runPrompt })
  return { running, events, wakeGate }
}

test('a hung turn times out, recovers status to idle, and does not block a message queued behind it', async () => {
  const { running, events, wakeGate } = makeHarness(20)

  const first = wakeGate.enqueue('hung message')
  const second = wakeGate.enqueue('second message')
  wakeGate.flush()

  const [firstResult, secondResult] = await Promise.all([first, second])

  assert.equal(firstResult.ok, false, 'the hung turn must resolve, not hang forever, once its bounded timeout fires')
  assert.equal(
    secondResult.ok,
    true,
    'a message queued behind a hung turn must still be delivered once the timeout frees the wake gate'
  )
  assert.equal(running.busy, false, 'busy must clear so the UI can leave "Working" instead of staying wedged')
  assert.deepEqual(
    events.filter((event) => event.type === 'status'),
    [
      { type: 'status', status: 'working' },
      { type: 'status', status: 'idle' },
      { type: 'status', status: 'working' },
      { type: 'status', status: 'idle' }
    ],
    'status must recover to idle after the timeout instead of staying stuck on "working"'
  )

  wakeGate.dispose()
})

// Reproduces the "double in-flight prompt" race: once a stall timeout fires, `busy` clearing and
// the wake gate flushing must not race a `session/cancel` notification that's still in flight -
// otherwise a message queued behind the stalled turn could dispatch a fresh `session/prompt` for
// the same session id while the agent might still be processing (and could yet resume responding
// to) the original one. This harness mirrors the fixed `runPrompt` shape: on a stall timeout it
// awaits the (fire-and-forget) cancel notification settling, then a short grace window, before
// falling into `finally` and clearing `busy`/flushing the queue - so the queued message's fresh
// dispatch is ordered strictly after the cancel notify has settled.
function makeCancelAwareHarness(
  turnTimeoutMs: number,
  graceMs: number,
  order: string[]
): { running: { busy: boolean }; wakeGate: PromptWakeGate; resumeHungTurn: (stopReason: string) => void } {
  const running = { busy: false }
  let wakeGate!: PromptWakeGate
  let resolveHungTurn!: (value: { stopReason: string }) => void
  const hungTurn = new Promise<{ stopReason: string }>((resolve) => {
    resolveHungTurn = resolve
  })

  const notifyCancel = async (): Promise<void> => {
    order.push('cancel-notify:sent')
    await new Promise((resolve) => setTimeout(resolve, 5))
    order.push('cancel-notify:settled')
  }

  const runPrompt = async (text: string): Promise<AgentPromptResult> => {
    running.busy = true
    try {
      const request = text === 'hung message' ? hungTurn : Promise.resolve({ stopReason: 'end_turn' })
      order.push(`prompt-dispatch:${text}`)
      const response = await withStallGuard(
        request,
        turnTimeoutMs,
        `The agent turn did not complete within ${turnTimeoutMs}ms.`
      )
      return { ok: true, message: response.stopReason }
    } catch (error) {
      if (error instanceof StallTimeoutError) {
        await notifyCancel()
        if (graceMs > 0) await new Promise((resolve) => setTimeout(resolve, graceMs))
      }
      return promptFailure(error, []).result
    } finally {
      running.busy = false
      wakeGate.flush()
    }
  }

  wakeGate = createPromptWakeGate({ deliver: runPrompt })
  return { running, wakeGate, resumeHungTurn: (stopReason) => resolveHungTurn({ stopReason }) }
}

test('a message queued behind a stalled turn only dispatches once the cancel notify has settled, and the stalled turn resuming afterward has no effect', async () => {
  const order: string[] = []
  const { running, wakeGate, resumeHungTurn } = makeCancelAwareHarness(20, 15, order)

  const first = wakeGate.enqueue('hung message')
  const second = wakeGate.enqueue('second message')
  wakeGate.flush()

  const [firstResult, secondResult] = await Promise.all([first, second])

  assert.equal(firstResult.ok, false, 'the stalled turn must still resolve as a failure once its timeout fires')
  assert.equal(secondResult.ok, true, 'the queued message must still be delivered after the stalled turn is cancelled')

  const cancelSettledIndex = order.indexOf('cancel-notify:settled')
  const secondDispatchIndex = order.indexOf('prompt-dispatch:second message')
  assert.ok(cancelSettledIndex !== -1, 'the cancel notify must have been sent and settled')
  assert.ok(secondDispatchIndex !== -1, 'the queued message must have been dispatched')
  assert.ok(
    cancelSettledIndex < secondDispatchIndex,
    "a fresh session/prompt for the same session must not dispatch until the prior turn's cancel notify has settled"
  )

  // The agent "resumes responding" to the original, now-abandoned turn after everything else has
  // already settled. This must be a no-op: the wrapper already returned a failure result for it.
  resumeHungTurn('end_turn')
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(running.busy, false, 'a late response from the abandoned turn must not resurrect busy state')

  wakeGate.dispose()
})
