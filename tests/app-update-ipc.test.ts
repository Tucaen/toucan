import { strict as assert } from 'node:assert'
import { test } from 'vitest'
import type { WebContents } from 'electron'
import { forwardAppUpdateChanges, registerAppUpdateIpc } from '../src/main/app-update-ipc'
import type { AppUpdater } from '../src/main/app-update'
import type { AppUpdateSnapshot } from '../src/shared/app-update'

function stubUpdater(overrides: Partial<AppUpdater> = {}): AppUpdater {
  return {
    snapshot: () => ({ currentVersion: '0.2.0', status: { phase: 'idle' } }),
    check: async () => ({ currentVersion: '0.2.0', status: { phase: 'checking' } }),
    quitAndInstall: () => false,
    onChange: () => () => {},
    ...overrides
  }
}

test('the renderer can read the snapshot, ask for a check and ask to restart', async () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  let restarted = false
  registerAppUpdateIpc(
    { handle: (channel, listener) => void handlers.set(channel, listener as (...args: unknown[]) => unknown) },
    stubUpdater({
      quitAndInstall: () => {
        restarted = true
        return true
      }
    })
  )
  const event = { sender: {} }

  assert.deepEqual(await handlers.get('app-update:state')!(event), {
    currentVersion: '0.2.0',
    status: { phase: 'idle' }
  })
  assert.deepEqual(await handlers.get('app-update:check')!(event), {
    currentVersion: '0.2.0',
    status: { phase: 'checking' }
  })
  assert.equal(await handlers.get('app-update:restart')!(event), true)
  assert.equal(restarted, true)
})

test('a window is sent every change while it lives and nothing once it is gone', () => {
  let publish: ((snapshot: AppUpdateSnapshot) => void) | null = null
  let unsubscribed = false
  const updater = stubUpdater({
    onChange: (listener) => {
      publish = listener
      return () => {
        unsubscribed = true
      }
    }
  })
  const sent: [string, AppUpdateSnapshot][] = []
  let destroyed = false
  const contents = {
    isDestroyed: () => destroyed,
    send: (channel: string, snapshot: AppUpdateSnapshot) => sent.push([channel, snapshot])
  } as unknown as WebContents

  const stop = forwardAppUpdateChanges(updater, contents)
  const downloaded: AppUpdateSnapshot = { currentVersion: '0.2.0', status: { phase: 'downloaded', version: '0.3.0' } }
  publish!(downloaded)
  destroyed = true
  publish!(downloaded)

  assert.deepEqual(sent, [['app-update:changed', downloaded]])
  stop()
  assert.equal(unsubscribed, true)
})
