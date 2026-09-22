import { strict as assert } from 'node:assert'
import { describe, test } from 'vitest'
import {
  appliedHostProbe,
  effectiveHostStatus,
  hostProbeDelayMs,
  hostStatus,
  HOST_PROBE_INTERVAL_MS,
  HOST_RETRY_BASE_MS,
  HOST_RETRY_CEILING_MS,
  HOST_UNPAIRED_PROBE_MS,
  hostStatusLabel,
  notedHostOutcome,
  prunedHostStatuses,
  unpairedHostStatus,
  UNKNOWN_HOST_STATUS,
  type HostStatuses
} from '../mobile/src/host-status'
import type { SavedHost } from '../mobile/src/hosts'

/**
 * Whether each saved host is actually there. The interesting part is not the labels but the retry
 * schedule and what resets it: a host that went down has to be found again quickly *and* stop being
 * hammered, and the two failures that look alike from a screen - a PC that is off and a token that
 * was revoked - must not share a schedule, because only one of them fixes itself.
 */

function host(id: string): SavedHost {
  return { id, name: id, origin: `http://${id}:1789`, token: 'abc' }
}

function offlineTimes(count: number): HostStatuses {
  let statuses: HostStatuses = {}
  for (let index = 0; index < count; index += 1) {
    statuses = appliedHostProbe(statuses, 'a', { ok: false, message: 'ECONNREFUSED' }, 1_000 + index)
  }
  return statuses
}

describe('what is known about a host', () => {
  test('an unprobed host is neither online nor offline', () => {
    assert.deepEqual(hostStatus({}, 'a'), UNKNOWN_HOST_STATUS)
    assert.equal(hostStatusLabel(UNKNOWN_HOST_STATUS), 'Checking…')
  })

  test('an outage carries the host’s own wording, so a colour is never the whole report', () => {
    const statuses = appliedHostProbe({}, 'a', { ok: false, message: 'ECONNREFUSED' }, 5)
    assert.deepEqual(statuses.a, {
      reachability: 'offline',
      message: 'ECONNREFUSED',
      attempt: 1,
      checkedAt: 5
    })
  })

  test('a host that answers again is online with the backoff wound back', () => {
    const recovered = appliedHostProbe(offlineTimes(4), 'a', { ok: true }, 9)
    assert.equal(recovered.a.reachability, 'online')
    assert.equal(recovered.a.attempt, 0)
    assert.equal(recovered.a.message, null)
  })

  test('a refused token is not an outage: the host is up and only its pairing is stale', () => {
    const statuses = appliedHostProbe(offlineTimes(2), 'a', { ok: false, unauthorized: true }, 9)
    assert.equal(statuses.a.reachability, 'unpaired')
    // Neither escalated nor reset: the count means consecutive *unreachable* results, and a `401`
    // is neither evidence of an outage nor evidence that one ended.
    assert.equal(statuses.a.attempt, 2)
  })

  test('a host with no token is reported without asking it anything', () => {
    assert.equal(unpairedHostStatus({}, 'a', 7).a.reachability, 'unpaired')
  })

  test('hosts fail independently, so one host’s outage says nothing about another', () => {
    const statuses = appliedHostProbe(offlineTimes(3), 'b', { ok: true }, 12)
    assert.equal(statuses.a.reachability, 'offline')
    assert.equal(statuses.b.reachability, 'online')
  })
})

describe('when a host is probed again', () => {
  test('a host that is up is a heartbeat, not a poll', () => {
    const online = appliedHostProbe({}, 'a', { ok: true }, 1)
    assert.equal(hostProbeDelayMs(online.a), HOST_PROBE_INTERVAL_MS)
    assert.equal(hostProbeDelayMs(UNKNOWN_HOST_STATUS), HOST_PROBE_INTERVAL_MS)
  })

  test('the first retry is quick, because most outages are a locked phone or a switched network', () => {
    assert.equal(hostProbeDelayMs(offlineTimes(1).a), HOST_RETRY_BASE_MS)
    assert.equal(hostProbeDelayMs(offlineTimes(2).a), HOST_RETRY_BASE_MS * 2)
  })

  test('the retry is bounded, so a PC that is genuinely off is still noticed coming back', () => {
    assert.equal(hostProbeDelayMs(offlineTimes(20).a), HOST_RETRY_CEILING_MS)
    // Monotonic and never abandoned: every delay stays inside the band.
    for (let attempt = 1; attempt <= 20; attempt += 1) {
      const delay = hostProbeDelayMs(offlineTimes(attempt).a)
      assert.ok(delay >= HOST_RETRY_BASE_MS && delay <= HOST_RETRY_CEILING_MS)
    }
  })

  test('a revoked token does not fix itself, so it is checked slowly', () => {
    const unpaired = appliedHostProbe({}, 'a', { ok: false, unauthorized: true }, 1)
    assert.equal(hostProbeDelayMs(unpaired.a), HOST_UNPAIRED_PROBE_MS)
  })
})

describe('hosts that are no longer saved', () => {
  test('stop reporting', () => {
    const statuses = appliedHostProbe(appliedHostProbe({}, 'a', { ok: true }, 1), 'b', { ok: true }, 1)
    assert.deepEqual(Object.keys(prunedHostStatuses(statuses, [host('a')])), ['a'])
  })
})

describe('a verdict another request already produced', () => {
  test('reports the reachability without pacing the schedule', () => {
    // The chat list polls the selected host every 3 seconds. If that fed the retry count, the
    // backoff would be pinned at its ceiling within seconds of an outage - paced by traffic that
    // has nothing to do with the schedule reading it.
    let statuses: HostStatuses = {}
    for (let index = 0; index < 10; index += 1) {
      statuses = notedHostOutcome(statuses, 'a', { ok: false, message: 'ECONNREFUSED' }, index)
    }
    assert.equal(statuses.a.reachability, 'offline')
    assert.equal(statuses.a.message, 'ECONNREFUSED')
    assert.equal(statuses.a.attempt, 0)
    // Still the first retry, because the schedule has not tried anything yet.
    assert.equal(hostProbeDelayMs(statuses.a), HOST_RETRY_BASE_MS)
  })

  test('a host that answered is up whoever asked it, so the backoff winds back either way', () => {
    const recovered = notedHostOutcome(offlineTimes(4), 'a', { ok: true }, 9)
    assert.equal(recovered.a.reachability, 'online')
    assert.equal(recovered.a.attempt, 0)
  })
})

describe('what a saved host is shown as', () => {
  test('a host with no token needs pairing whatever the last probe said', () => {
    // A token revoked a moment ago leaves a stale `online` in the map until the loop catches up,
    // and "Online" is the one thing that host is not usefully doing.
    const online = appliedHostProbe({}, 'a', { ok: true }, 1)
    const revoked: SavedHost = { ...host('a'), token: '' }
    assert.equal(effectiveHostStatus(revoked, online).reachability, 'unpaired')
    assert.equal(effectiveHostStatus(revoked, online).message, null)
    assert.equal(hostStatusLabel(effectiveHostStatus(revoked, online)), 'Needs pairing')
  })

  test('a paired host is shown as whatever was last observed', () => {
    const offline = appliedHostProbe({}, 'a', { ok: false, message: 'ECONNREFUSED' }, 1)
    assert.equal(effectiveHostStatus(host('a'), offline), offline.a)
  })
})
