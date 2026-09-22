import { strict as assert } from 'node:assert'
import { test } from 'vitest'
import { appUpdateSkipReason, nextAppUpdateStatus, type AppUpdateStatus } from '../src/shared/app-update'

/**
 * The update state machine, exercised as the sequences electron-updater actually emits - including
 * the ones that arrive out of order or after the user already has a package waiting.
 */

function fold(events: Parameters<typeof nextAppUpdateStatus>[1][]): AppUpdateStatus {
  return events.reduce<AppUpdateStatus>((status, event) => nextAppUpdateStatus(status, event), { phase: 'idle' })
}

test('a check that finds a release walks idle to checking to available to downloaded', () => {
  assert.deepEqual(fold([{ type: 'check-started' }]), { phase: 'checking' })
  assert.deepEqual(fold([{ type: 'check-started' }, { type: 'available', version: '0.3.0' }]), {
    phase: 'available',
    version: '0.3.0'
  })
  assert.deepEqual(
    fold([
      { type: 'check-started' },
      { type: 'available', version: '0.3.0' },
      { type: 'downloaded', version: '0.3.0' }
    ]),
    { phase: 'downloaded', version: '0.3.0' }
  )
})

test('a check that finds nothing reports up to date rather than falling back to idle', () => {
  assert.deepEqual(fold([{ type: 'check-started' }, { type: 'not-available' }]), { phase: 'up-to-date' })
})

test('a failed check is an error the caller can phrase, and the next check clears it', () => {
  assert.deepEqual(fold([{ type: 'check-started' }, { type: 'error', message: 'getaddrinfo ENOTFOUND' }]), {
    phase: 'error',
    message: 'getaddrinfo ENOTFOUND'
  })
  assert.deepEqual(
    fold([{ type: 'check-started' }, { type: 'error', message: 'offline' }, { type: 'check-started' }]),
    { phase: 'checking' }
  )
})

test('a downloaded package outlives every later event, because restarting still installs it', () => {
  const downloaded: AppUpdateStatus = { phase: 'downloaded', version: '0.3.0' }
  for (const event of [
    { type: 'check-started' } as const,
    { type: 'not-available' } as const,
    { type: 'error', message: 'offline' } as const,
    { type: 'available', version: '0.3.0' } as const
  ])
    assert.deepEqual(nextAppUpdateStatus(downloaded, event), downloaded)
})

test('a newer package replaces the one already downloaded', () => {
  assert.deepEqual(
    nextAppUpdateStatus({ phase: 'downloaded', version: '0.3.0' }, { type: 'downloaded', version: '0.4.0' }),
    {
      phase: 'downloaded',
      version: '0.4.0'
    }
  )
})

test('development and portable runs are the two that never contact the feed', () => {
  assert.equal(appUpdateSkipReason({ packaged: false, environment: {} }), 'development')
  assert.equal(
    appUpdateSkipReason({ packaged: true, environment: { PORTABLE_EXECUTABLE_DIR: 'D:\\Downloads' } }),
    'portable'
  )
  // An empty value is what a non-portable build inherits from a shell that exported the name.
  assert.equal(appUpdateSkipReason({ packaged: true, environment: { PORTABLE_EXECUTABLE_DIR: '' } }), null)
  assert.equal(appUpdateSkipReason({ packaged: true, environment: {} }), null)
})
