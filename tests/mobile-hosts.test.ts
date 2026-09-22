import { strict as assert } from 'node:assert'
import { describe, test } from 'vitest'
import {
  addHost,
  EMPTY_HOST_DIRECTORY,
  hostApiUrl,
  hostBlockedByPageScheme,
  hostDraftProblem,
  hostNeedsPairing,
  hostSocketUrl,
  migratedHostDirectory,
  normalizeHostOrigin,
  parseHostDirectory,
  removeHost,
  renameHost,
  revokedHostToken,
  selectedHost,
  selectHost,
  type HostDirectory
} from '../mobile/src/hosts'

/**
 * The phone's saved hosts, without a DOM. This list is the one piece of state the mobile client
 * genuinely owns - everything else is the desktop's, read live - so what is worth pinning here is
 * the identity rule (an origin names a host, so re-pairing is not a second entry), the isolation
 * rule (a revoked token costs exactly one host), and the fact that a stored list is read back
 * forgivingly, because losing it would cost the reader every pairing they have.
 */

function directory(...origins: string[]): HostDirectory {
  return origins.reduce(
    (current, origin, index) => addHost(current, { name: '', origin, token: `token-${index}` }, `host-${index}`),
    EMPTY_HOST_DIRECTORY
  )
}

describe('what a typed host address means', () => {
  test('a scheme may be left off, because a phone keyboard is a hostile place to type one', () => {
    assert.equal(normalizeHostOrigin('work-pc:1789'), 'http://work-pc:1789')
    assert.equal(normalizeHostOrigin('  work-pc.tail1234.ts.net  '), 'http://work-pc.tail1234.ts.net')
    assert.equal(normalizeHostOrigin('https://work-pc.tail1234.ts.net'), 'https://work-pc.tail1234.ts.net')
  })

  test('a pasted deep link is trimmed back to its host rather than refused', () => {
    // Two entries for one PC is the failure this prevents: the reader pastes whatever is in their
    // clipboard, and a chat URL is the likeliest thing to be there.
    assert.equal(normalizeHostOrigin('http://work-pc:1789/chats/abc?x=1#y'), 'http://work-pc:1789')
  })

  test('anything that is not a reachable HTTP address is nothing', () => {
    assert.equal(normalizeHostOrigin(''), null)
    assert.equal(normalizeHostOrigin('   '), null)
    assert.equal(normalizeHostOrigin('file:///c:/toucan'), null)
    assert.equal(normalizeHostOrigin('javascript:alert(1)'), null)
    assert.equal(normalizeHostOrigin('http://'), null)
  })

  test('the form refuses an unusable address and a missing token in its own words', () => {
    assert.equal(hostDraftProblem({ name: '', origin: 'work-pc:1789', token: 'abc' }), null)
    assert.equal(hostDraftProblem({ name: '', origin: '', token: 'abc' }), 'Enter the address Toucan is listening on.')
    assert.equal(
      hostDraftProblem({ name: '', origin: 'file:///x', token: 'abc' }),
      'That is not an address this app can reach.'
    )
    assert.equal(
      hostDraftProblem({ name: '', origin: 'work-pc:1789', token: '  ' }),
      'Paste the pairing token from that desktop.'
    )
  })
})

describe('saving hosts', () => {
  test('an added host is selected, and an unnamed one is named after the machine', () => {
    const saved = addHost(EMPTY_HOST_DIRECTORY, { name: '', origin: 'work-pc:1789', token: 'abc' }, 'host-1')
    assert.deepEqual(saved, {
      hosts: [{ id: 'host-1', name: 'work-pc', origin: 'http://work-pc:1789', token: 'abc' }],
      selectedId: 'host-1'
    })
  })

  test('two real hosts are held side by side, each with its own token', () => {
    const saved = directory('work-pc:1789', 'home-pc:1789')
    assert.deepEqual(
      saved.hosts.map((host) => [host.origin, host.token]),
      [
        ['http://work-pc:1789', 'token-0'],
        ['http://home-pc:1789', 'token-1']
      ]
    )
    assert.equal(saved.selectedId, 'host-1')
  })

  test('the same origin re-pairs the entry it already has rather than adding a second', () => {
    const saved = directory('work-pc:1789', 'home-pc:1789')
    const repaired = addHost(saved, { name: '', origin: 'http://work-pc:1789/chats/x', token: 'fresh' }, 'host-9')
    assert.equal(repaired.hosts.length, 2)
    // The id survives, which is what keeps this host's retained drafts and screens addressable.
    assert.deepEqual(repaired.hosts[0], {
      id: 'host-0',
      name: 'work-pc',
      origin: 'http://work-pc:1789',
      token: 'fresh'
    })
    assert.equal(repaired.selectedId, 'host-0')
  })

  test('re-pairing keeps the name it was given unless a new one was typed', () => {
    const named = addHost(EMPTY_HOST_DIRECTORY, { name: 'Work PC', origin: 'work-pc:1789', token: 'a' }, 'host-1')
    assert.equal(addHost(named, { name: '', origin: 'work-pc:1789', token: 'b' }, 'x').hosts[0].name, 'Work PC')
    assert.equal(addHost(named, { name: 'Office', origin: 'work-pc:1789', token: 'b' }, 'x').hosts[0].name, 'Office')
  })

  test('an unusable address saves nothing at all', () => {
    assert.equal(addHost(EMPTY_HOST_DIRECTORY, { name: 'x', origin: 'nope://x', token: 'a' }, 'host-1').hosts.length, 0)
  })
})

describe('renaming, removing and switching', () => {
  test('a rename to nothing is not a rename', () => {
    const saved = directory('work-pc:1789')
    assert.equal(renameHost(saved, 'host-0', '  Office  ').hosts[0].name, 'Office')
    assert.equal(renameHost(saved, 'host-0', '   '), saved)
  })

  test('removing the selected host moves the selection to what is left', () => {
    const saved = selectHost(directory('work-pc:1789', 'home-pc:1789'), 'host-0')
    const removed = removeHost(saved, 'host-0')
    // Not null: a phone with another paired host must not be sent back to the pairing screen.
    assert.equal(removed.selectedId, 'host-1')
    assert.equal(removed.hosts.length, 1)
  })

  test('removing the last host leaves nothing selected', () => {
    assert.equal(removeHost(directory('work-pc:1789'), 'host-0').selectedId, null)
  })

  test('removing a host that is not selected leaves the selection alone', () => {
    const saved = selectHost(directory('work-pc:1789', 'home-pc:1789'), 'host-1')
    assert.equal(removeHost(saved, 'host-0').selectedId, 'host-1')
  })

  test('selecting a host that is not in the list changes nothing', () => {
    const saved = directory('work-pc:1789')
    assert.equal(selectHost(saved, 'host-404'), saved)
  })
})

describe('a token that stopped being accepted', () => {
  test('flips only its own host into re-pairing', () => {
    const saved = directory('work-pc:1789', 'home-pc:1789')
    const revoked = revokedHostToken(saved, 'host-0')
    assert.equal(hostNeedsPairing(revoked.hosts[0]), true)
    // The whole point of a per-host token: the other PC is still paired and still drivable.
    assert.equal(hostNeedsPairing(revoked.hosts[1]), false)
    assert.equal(revoked.hosts[1].token, 'token-1')
  })

  test('keeps the selection, because the re-pair screen is that host\u2019s', () => {
    const saved = selectHost(directory('work-pc:1789', 'home-pc:1789'), 'host-0')
    assert.equal(revokedHostToken(saved, 'host-0').selectedId, 'host-0')
    assert.equal(selectedHost(revokedHostToken(saved, 'host-0'))?.id, 'host-0')
  })
})

describe('addressing a host', () => {
  test('API paths are absolute against the host, never against the page that served the client', () => {
    assert.equal(hostApiUrl('http://home-pc:1789', '/api/workspace'), 'http://home-pc:1789/api/workspace')
  })

  test('the socket follows the host\u2019s own scheme', () => {
    assert.equal(hostSocketUrl('http://home-pc:1789', '/api/chats/n1'), 'ws://home-pc:1789/api/chats/n1')
    assert.equal(hostSocketUrl('https://home-pc.ts.net', '/api/chats/n1'), 'wss://home-pc.ts.net/api/chats/n1')
  })

  test('a plain-HTTP host is named as unreachable from an HTTPS page rather than left to fail silently', () => {
    assert.match(
      hostBlockedByPageScheme('http://home-pc:1789', 'https:') ?? '',
      /will not connect to a plain-HTTP host/
    )
    assert.equal(hostBlockedByPageScheme('https://home-pc.ts.net', 'https:'), null)
    // An HTTP page may reach either, so there is nothing to warn about.
    assert.equal(hostBlockedByPageScheme('http://home-pc:1789', 'http:'), null)
  })
})

describe('reading a stored host list back', () => {
  test('a saved list survives a restart verbatim', () => {
    const saved = selectHost(directory('work-pc:1789', 'home-pc:1789'), 'host-1')
    assert.deepEqual(parseHostDirectory(JSON.parse(JSON.stringify(saved))), saved)
  })

  test('a damaged entry is dropped, and the hosts around it are kept', () => {
    // Forgiving rather than validating: refusing the whole list would cost every pairing the
    // reader has, and every one of these shapes can only come from a version skew or a torn write.
    const parsed = parseHostDirectory({
      hosts: [
        { id: 'a', name: 'Work', origin: 'http://work-pc:1789', token: 'abc' },
        { id: '', name: 'No id', origin: 'http://x:1' },
        { id: 'c', name: 'Bad origin', origin: 'file:///x', token: 'z' },
        'not a host',
        { id: 'd', origin: 'home-pc:1789' }
      ],
      selectedId: 'a'
    })
    assert.deepEqual(
      parsed.hosts.map((host) => host.id),
      ['a', 'd']
    )
    // A missing token is not a broken entry: it is a host that needs re-pairing, which this client
    // already knows how to present.
    assert.equal(hostNeedsPairing(parsed.hosts[1]), true)
    assert.equal(parsed.hosts[1].name, 'home-pc')
  })

  test('a selection naming a host that did not survive falls back rather than showing an empty list', () => {
    const parsed = parseHostDirectory({
      hosts: [{ id: 'a', name: 'Work', origin: 'http://work-pc:1789', token: 'abc' }],
      selectedId: 'gone'
    })
    assert.equal(parsed.selectedId, 'a')
  })

  test('anything that is not a host list at all reads as no hosts', () => {
    assert.deepEqual(parseHostDirectory(null), EMPTY_HOST_DIRECTORY)
    assert.deepEqual(parseHostDirectory({ hosts: 'nope' }), EMPTY_HOST_DIRECTORY)
    assert.deepEqual(parseHostDirectory({ hosts: [] }), EMPTY_HOST_DIRECTORY)
  })

  test('a device paired before there was a host list keeps that pairing', () => {
    const migrated = migratedHostDirectory('legacy-token', 'http://work-pc:1789', 'host-1')
    assert.deepEqual(migrated.hosts, [
      { id: 'host-1', name: 'work-pc', origin: 'http://work-pc:1789', token: 'legacy-token' }
    ])
    assert.equal(migrated.selectedId, 'host-1')
  })
})
