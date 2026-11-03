import { strict as assert } from 'node:assert'
import { describe, test } from 'vitest'
import {
  parseAppUpdateSnapshot,
  parseRemoteRestartReply,
  parseRemoteRestartRequest
} from '../src/shared/remote-app-update'

describe('the phone update contract', () => {
  test('an empty restart body is unconfirmed, and only a boolean flag is accepted', () => {
    assert.deepEqual(parseRemoteRestartRequest(''), { confirmed: false })
    assert.deepEqual(parseRemoteRestartRequest('{}'), { confirmed: false })
    assert.deepEqual(parseRemoteRestartRequest('{"confirmed":true}'), { confirmed: true })
    assert.equal(parseRemoteRestartRequest('{"confirmed":"yes"}'), null)
    assert.equal(parseRemoteRestartRequest('[]'), null)
    assert.equal(parseRemoteRestartRequest('not json'), null)
  })

  test('a snapshot is parsed per phase, and a damaged one is none', () => {
    assert.deepEqual(parseAppUpdateSnapshot({ currentVersion: '1.0.0', status: { phase: 'checking' } }), {
      currentVersion: '1.0.0',
      status: { phase: 'checking' }
    })
    assert.deepEqual(
      parseAppUpdateSnapshot({ currentVersion: '1.0.0', status: { phase: 'downloaded', version: '1.0.1' } }),
      { currentVersion: '1.0.0', status: { phase: 'downloaded', version: '1.0.1' } }
    )
    assert.equal(parseAppUpdateSnapshot({ currentVersion: '1.0.0', status: { phase: 'downloaded' } }), null)
    assert.equal(parseAppUpdateSnapshot({ currentVersion: '1.0.0', status: { phase: 'rebooting' } }), null)
    assert.equal(parseAppUpdateSnapshot({ status: { phase: 'idle' } }), null)
  })

  test('a restart reply is restarting, a warning to confirm, or a reason', () => {
    assert.deepEqual(parseRemoteRestartReply({ restarting: true }), { restarting: true })
    const confirm = { title: 'Restart to update?', message: 'm', detail: 'd', proceedLabel: 'Restart anyway' }
    assert.deepEqual(parseRemoteRestartReply({ restarting: false, confirm }), { restarting: false, confirm })
    assert.deepEqual(parseRemoteRestartReply({ restarting: false, error: 'No update' }), {
      restarting: false,
      error: 'No update'
    })
    assert.equal(parseRemoteRestartReply({ restarting: false, confirm: { title: 'x' } }), null)
    assert.equal(parseRemoteRestartReply(null), null)
  })
})
