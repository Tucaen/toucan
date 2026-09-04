import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import { createRemoteChatSpawner, SPAWN_CHAT_CHANNEL, type SpawnWindow } from '../src/main/remote/chat-spawn'
import type { RemoteChatSpawnRequest } from '../src/shared/remote-spawn'

/**
 * The round-trip that makes a remotely spawned node indistinguishable from a canvas-created one:
 * main never mints a node, it asks a window to.
 *
 * What is worth testing here is not the happy path but the three ways a desktop can fail to
 * answer - no window, a window that goes away, a renderer that never replies - because each one
 * has a phone holding an open HTTP request on the other end, and a spawn that resolves to nothing
 * is exactly the phantom chat this design exists to prevent.
 */

const request: RemoteChatSpawnRequest = { projectId: 'toucan', kind: 'claude', input: 'go' }

/** A window that records what it was asked, and can be told it has been destroyed. */
function fakeWindow(): SpawnWindow & { sent: { channel: string; args: unknown[] }[]; destroy(): void } {
  let destroyed = false
  const sent: { channel: string; args: unknown[] }[] = []
  return {
    sent,
    destroy: () => {
      destroyed = true
    },
    isDestroyed: () => destroyed,
    send: (channel, ...args) => sent.push({ channel, args })
  }
}

/** Fires scheduled work on demand, so a timeout is a decision rather than a wait. */
function manualClock(): { schedule: (run: () => void, delayMs: number) => { cancel(): void }; fire(): void } {
  let pending: (() => void) | null = null
  return {
    schedule: (run) => {
      pending = run
      return {
        cancel: () => {
          pending = null
        }
      }
    },
    fire: () => {
      const run = pending
      pending = null
      run?.()
    }
  }
}

describe('spawning a chat through the desktop renderer', () => {
  test('asks the attached window and answers with what it minted', async () => {
    const spawner = createRemoteChatSpawner({ requestId: () => 'req-1' })
    const window = fakeWindow()
    spawner.attach(window)

    const pending = spawner.spawn(request)
    assert.deepEqual(window.sent, [{ channel: SPAWN_CHAT_CHANNEL, args: ['req-1', request] }])

    spawner.complete('req-1', { ok: true, chatId: 'node-9' })
    assert.deepEqual(await pending, { ok: true, chatId: 'node-9' })
  })

  test('a renderer refusal is passed through as it was written', async () => {
    const spawner = createRemoteChatSpawner({ requestId: () => 'req-1' })
    spawner.attach(fakeWindow())

    const pending = spawner.spawn(request)
    spawner.complete('req-1', { ok: false, message: 'That project is no longer open on the desktop.' })
    assert.deepEqual(await pending, { ok: false, message: 'That project is no longer open on the desktop.' })
  })

  test('with no window open it refuses immediately rather than waiting', async () => {
    const spawner = createRemoteChatSpawner()
    assert.deepEqual(await spawner.spawn(request), {
      ok: false,
      message: 'Toucan is not open on the desktop, so there is nothing to start the chat in.'
    })
  })

  test('a destroyed window is not a spawn target', async () => {
    const spawner = createRemoteChatSpawner()
    const window = fakeWindow()
    spawner.attach(window)
    window.destroy()

    const result = await spawner.spawn(request)
    assert.equal(result.ok, false)
    assert.equal(window.sent.length, 0)
  })

  test('the newest live window performs the spawn', async () => {
    const spawner = createRemoteChatSpawner({ requestId: () => 'req-1' })
    const first = fakeWindow()
    const second = fakeWindow()
    spawner.attach(first)
    spawner.attach(second)

    void spawner.spawn(request)
    assert.equal(first.sent.length, 0)
    assert.equal(second.sent.length, 1)
  })

  test('a window that closes mid-spawn refuses the request it was holding', async () => {
    const spawner = createRemoteChatSpawner({ requestId: () => 'req-1' })
    const window = fakeWindow()
    const detach = spawner.attach(window)

    const pending = spawner.spawn(request)
    detach()
    assert.deepEqual(await pending, { ok: false, message: 'The Toucan window closed before the chat was started.' })
  })

  test('a renderer that never answers is refused rather than left open', async () => {
    const clock = manualClock()
    const spawner = createRemoteChatSpawner({ requestId: () => 'req-1', schedule: clock.schedule })
    spawner.attach(fakeWindow())

    const pending = spawner.spawn(request)
    clock.fire()
    assert.deepEqual(await pending, {
      ok: false,
      message: 'The desktop did not finish starting the chat in time. It may still appear in your chat list.'
    })

    // The late answer arrives after the verdict was already given, and changes nothing.
    spawner.complete('req-1', { ok: true, chatId: 'node-9' })
  })

  test('an answer for an unknown request is ignored', () => {
    const spawner = createRemoteChatSpawner()
    assert.doesNotThrow(() => spawner.complete('never-asked', { ok: true, chatId: 'node-9' }))
  })
})
