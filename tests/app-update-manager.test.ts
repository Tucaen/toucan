import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { createAppUpdater, type AppUpdaterPort } from '../src/main/app-update'
import type { AppUpdateSnapshot } from '../src/shared/app-update'

/**
 * The host side of updating, driven against a stand-in for electron-updater. The point of the
 * seam is that none of this needs a packaged app, a network or a release feed to be pinned down.
 */

interface FakeUpdater extends AppUpdaterPort {
  emit(event: string, payload?: unknown): void
  checks: number
  installs: number
  installArgs: [isSilent: boolean | undefined, isForceRunAfter: boolean | undefined][]
  rejectWith?: Error
}

function fakeUpdater(): FakeUpdater {
  const listeners = new Map<string, ((payload?: unknown) => void)[]>()
  const updater: FakeUpdater = {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    checks: 0,
    installs: 0,
    installArgs: [],
    on(event, listener) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener as (payload?: unknown) => void])
    },
    async checkForUpdates() {
      updater.checks += 1
      if (updater.rejectWith !== undefined) throw updater.rejectWith
      return null
    },
    quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean) {
      updater.installs += 1
      updater.installArgs.push([isSilent, isForceRunAfter])
    },
    emit(event, payload) {
      for (const listener of listeners.get(event) ?? []) listener(payload)
    }
  }
  return updater
}

function installedUpdater(updater: FakeUpdater, environment: Record<string, string | undefined> = {}) {
  const logged: string[] = []
  const seen: AppUpdateSnapshot[] = []
  const app = createAppUpdater({
    updater,
    currentVersion: '0.2.0',
    packaged: true,
    environment,
    log: (message) => logged.push(message)
  })
  app.onChange((snapshot) => seen.push(snapshot))
  return { app, logged, seen }
}

test('a packaged run checks on start and reports the package it downloaded', async () => {
  const updater = fakeUpdater()
  const { app, seen } = installedUpdater(updater)
  await app.check()

  assert.equal(updater.checks, 1)
  updater.emit('update-available', { version: '0.3.0' })
  assert.deepEqual(app.snapshot(), { currentVersion: '0.2.0', status: { phase: 'available', version: '0.3.0' } })
  updater.emit('update-downloaded', { version: '0.3.0' })
  assert.deepEqual(app.snapshot(), { currentVersion: '0.2.0', status: { phase: 'downloaded', version: '0.3.0' } })
  // Subscribers see every transition, not only the last one: the banner appears when it appears.
  assert.deepEqual(
    seen.map(({ status }) => status.phase),
    ['checking', 'available', 'downloaded']
  )
})

test('nothing to update reads as up to date, and the version stays the running one', async () => {
  const updater = fakeUpdater()
  const { app } = installedUpdater(updater)
  await app.check()
  updater.emit('update-not-available', { version: '0.2.0' })
  assert.deepEqual(app.snapshot(), { currentVersion: '0.2.0', status: { phase: 'up-to-date' } })
})

test('a feed that cannot be reached logs and settles as an error instead of throwing', async () => {
  const updater = fakeUpdater()
  updater.rejectWith = new Error('getaddrinfo ENOTFOUND github.com')
  const { app, logged } = installedUpdater(updater)
  await app.check()

  assert.deepEqual(app.snapshot().status, { phase: 'error', message: 'getaddrinfo ENOTFOUND github.com' })
  assert.ok(logged.some((line) => line.includes('getaddrinfo ENOTFOUND github.com')))
})

test('an error the updater emits after the check resolved is caught the same way', async () => {
  const updater = fakeUpdater()
  const { app } = installedUpdater(updater)
  await app.check()
  updater.emit('error', new Error('HttpError: 404'))
  assert.deepEqual(app.snapshot().status, { phase: 'error', message: 'HttpError: 404' })
})

test('development and portable runs never subscribe, never check and never offer an install', async () => {
  for (const [environment, packaged, reason] of [
    [{}, false, 'development'],
    [{ PORTABLE_EXECUTABLE_DIR: 'D:\Downloads' }, true, 'portable']
  ] as const) {
    const updater = fakeUpdater()
    const logged: string[] = []
    const app = createAppUpdater({
      updater,
      currentVersion: '0.2.0',
      packaged,
      environment,
      log: (message) => logged.push(message)
    })
    await app.check()

    assert.equal(updater.checks, 0)
    assert.deepEqual(app.snapshot(), { currentVersion: '0.2.0', status: { phase: 'idle' } })
    assert.equal(app.quitAndInstall(), false)
    assert.ok(logged.some((line) => line.includes(reason)))
    // Not subscribed at all, so a stray event from a shared updater cannot move the state either.
    updater.emit('update-downloaded', { version: '0.3.0' })
    assert.equal(app.snapshot().status.phase, 'idle')
  }
})

test('restarting into the update is refused until there is a package to restart into', async () => {
  const updater = fakeUpdater()
  const { app } = installedUpdater(updater)
  await app.check()

  assert.equal(app.quitAndInstall(), false)
  assert.equal(updater.installs, 0)
  updater.emit('update-downloaded', { version: '0.3.0' })
  assert.equal(app.quitAndInstall(), true)
  assert.equal(updater.installs, 1)
})

test('the restart installs silently and relaunches, so an update never replays the install wizard', async () => {
  const updater = fakeUpdater()
  const { app } = installedUpdater(updater)
  await app.check()
  updater.emit('update-downloaded', { version: '0.3.0' })

  app.quitAndInstall()
  // isSilent runs the assisted NSIS installer with `/S` into the recorded install directory;
  // isForceRunAfter is the only thing that makes a silent assisted install start the app again.
  assert.deepEqual(updater.installArgs, [[true, true]])
})

test('quitting never installs behind the user; only the explicit restart does', async () => {
  const updater = fakeUpdater()
  const { app } = installedUpdater(updater)
  await app.check()
  assert.equal(updater.autoInstallOnAppQuit, false)
  assert.equal(updater.autoDownload, true)
})

test('a later check reports the snapshot it settled on', async () => {
  const updater = fakeUpdater()
  const { app } = installedUpdater(updater)
  await app.check()
  updater.emit('update-not-available', { version: '0.2.0' })

  const settled = await app.check()
  assert.equal(updater.checks, 2)
  // The check itself only starts the run; the phase it leaves behind is whatever the feed said.
  assert.equal(settled.status.phase, 'checking')
})

test('a release without a readable version is ignored rather than shown as an update to nothing', async () => {
  const updater = fakeUpdater()
  const { app } = installedUpdater(updater)
  await app.check()
  updater.emit('update-available', {})
  updater.emit('update-downloaded', { version: 42 })
  assert.equal(app.snapshot().status.phase, 'checking')
})
