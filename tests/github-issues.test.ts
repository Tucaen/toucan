import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import type { GithubIssueRecord } from '../src/shared/github-issues'
import {
  DEFAULT_GITHUB_STATUS_LABELS,
  GITHUB_ISSUE_FIELDS,
  TICKET_GITHUB_SOURCE_ID,
  githubIssueCard,
  githubIssueStatus,
  githubRemoteRepository,
  githubStatusLabelsFor,
  parseGithubIssues
} from '../src/shared/github-issues'

/**
 * The pure half of the GitHub source: how an issue becomes a column, how `gh`'s JSON becomes
 * cards, and how a checkout is recognised as living on GitHub. None of it launches anything.
 */

function issue(overrides: Partial<GithubIssueRecord> = {}): GithubIssueRecord {
  return {
    number: 147,
    title: 'GitHub issues as a second ticket source',
    state: 'OPEN',
    updatedAt: '2026-09-04T14:50:06Z',
    labels: [{ name: 'enhancement' }],
    url: 'https://github.com/tucaen/toucan/issues/147',
    body: 'The body.',
    ...overrides
  }
}

test('a closed issue is done whatever it is labelled', () => {
  assert.equal(githubIssueStatus({ state: 'CLOSED', labels: [{ name: 'blocked' }] }), 'done')
  assert.equal(githubIssueStatus({ state: 'closed', labels: [] }), 'done')
})

test('an open issue takes its column from its labels, blocked winning over in progress', () => {
  assert.equal(githubIssueStatus({ state: 'OPEN', labels: [{ name: 'enhancement' }] }), 'open')
  assert.equal(githubIssueStatus({ state: 'OPEN', labels: [{ name: 'in-progress' }] }), 'in-progress')
  assert.equal(githubIssueStatus({ state: 'OPEN', labels: [{ name: 'blocked' }] }), 'blocked')
  assert.equal(githubIssueStatus({ state: 'OPEN', labels: [{ name: 'in-progress' }, { name: 'blocked' }] }), 'blocked')
})

test('a project may name the label that means in progress, and blank means the default', () => {
  const labels = githubStatusLabelsFor('doing')
  assert.deepEqual(labels, { blocked: 'blocked', inProgress: 'doing' })
  assert.equal(githubIssueStatus({ state: 'OPEN', labels: [{ name: 'Doing' }] }, labels), 'in-progress')
  assert.equal(githubIssueStatus({ state: 'OPEN', labels: [{ name: 'in-progress' }] }, labels), 'open')
  assert.equal(githubIssueStatus({ state: 'OPEN', labels: [{ name: 'blocked' }] }, labels), 'blocked')
  assert.equal(githubStatusLabelsFor('  '), DEFAULT_GITHUB_STATUS_LABELS)
  assert.equal(githubStatusLabelsFor(undefined), DEFAULT_GITHUB_STATUS_LABELS)
  assert.equal(
    parseGithubIssues(JSON.stringify([issue({ labels: [{ name: 'doing' }] })]), labels).cards[0].status,
    'in-progress'
  )
})

test('label matching ignores the casing and spacing a repository happens to use', () => {
  assert.equal(githubIssueStatus({ state: 'OPEN', labels: [{ name: 'In Progress' }] }), 'in-progress')
  assert.equal(githubIssueStatus({ state: 'OPEN', labels: [{ name: '  BLOCKED ' }] }), 'blocked')
})

test('an issue becomes a card the board cannot tell from a file', () => {
  assert.deepEqual(githubIssueCard(issue()), {
    sourceId: TICKET_GITHUB_SOURCE_ID,
    id: '147',
    title: 'GitHub issues as a second ticket source',
    status: 'open',
    updated: '2026-09-04',
    body: 'The body.',
    url: 'https://github.com/tucaen/toucan/issues/147'
  })
})

test('a card omits what the issue did not answer rather than inventing it', () => {
  const card = githubIssueCard({ number: 3, title: 'Bare', state: 'OPEN', updatedAt: '2026-01-02T03:04:05Z' })
  assert.equal(card.body, undefined)
  assert.equal(card.url, undefined)
  assert.equal(card.blockedBy, undefined)
})

test('the requested fields are exactly what the card reads', () => {
  assert.deepEqual([...GITHUB_ISSUE_FIELDS].sort(), ['body', 'labels', 'number', 'state', 'title', 'updatedAt', 'url'])
})

test('parsing keeps the readable issues and reports the rest', () => {
  const parsed = parseGithubIssues(JSON.stringify([issue(), { number: 9 }, issue({ number: 12, state: 'CLOSED' })]))
  assert.deepEqual(
    parsed.cards.map((card) => [card.id, card.status]),
    [
      ['147', 'open'],
      ['12', 'done']
    ]
  )
  assert.equal(parsed.diagnostics.length, 1)
  assert.equal(parsed.diagnostics[0].code, 'malformed-issue')
})

test('output that is not a list of issues is one diagnostic, never a throw', () => {
  assert.equal(parseGithubIssues('not json').diagnostics[0].code, 'unreadable-issues')
  assert.equal(parseGithubIssues('{"issues":[]}').diagnostics[0].code, 'unreadable-issues')
  assert.deepEqual(parseGithubIssues('[]'), { cards: [], diagnostics: [] })
})

test('a GitHub remote is recognised in every URL form git writes', () => {
  assert.equal(githubRemoteRepository('origin\thttps://github.com/tucaen/toucan.git (fetch)\n'), 'tucaen/toucan')
  assert.equal(githubRemoteRepository('origin\tgit@github.com:tucaen/toucan.git (push)\n'), 'tucaen/toucan')
  assert.equal(githubRemoteRepository('origin\tssh://git@github.com/tucaen/toucan (fetch)\n'), 'tucaen/toucan')
})

test('origin wins when a checkout has several remotes, and a non-GitHub host is not one', () => {
  const remotes = [
    'fork\thttps://github.com/someone/toucan.git (fetch)',
    'origin\thttps://github.com/tucaen/toucan.git (fetch)'
  ].join('\n')
  assert.equal(githubRemoteRepository(remotes), 'tucaen/toucan')
  assert.equal(githubRemoteRepository('origin\thttps://gitlab.com/tucaen/toucan.git (fetch)\n'), null)
  assert.equal(githubRemoteRepository(''), null)
})
