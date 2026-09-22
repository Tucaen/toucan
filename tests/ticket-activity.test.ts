import { strict as assert } from 'node:assert'
import { test } from 'vitest'
import type { AgentActivity } from '../src/shared/agent'
import type { AgentTranscriptEntry } from '../src/shared/agent-transcript'
import {
  recentlyWrittenPaths,
  ticketSessionsFromNodes,
  ticketSlugFor,
  ticketsRootFor,
  type TicketActivityReport,
  type TicketSessionNode
} from '../src/renderer/src/ticket-activity'

const PROJECT = 'D:\\Development\\Toucan'

function write(id: string, path: string): AgentActivity {
  return { id, toolName: 'Write', rawInput: { file_path: path, content: '# ticket' } }
}

function read(id: string, path: string): AgentActivity {
  return { id, toolName: 'Read', rawInput: { file_path: path } }
}

/** `user` and `assistant` become messages; anything else is an activity with that call id. */
function transcriptOf(...entries: string[]): AgentTranscriptEntry[] {
  return entries.map((entry, index) =>
    entry === 'user' || entry === 'assistant'
      ? ({ type: 'message', id: `message-${index}`, role: entry } as AgentTranscriptEntry)
      : ({ type: 'activity', id: entry } as AgentTranscriptEntry)
  )
}

const RUNNING = { working: true }
const BETWEEN_TURNS = { working: false }

test('a write in the current turn is reported, a read is not', () => {
  const ticket = `${PROJECT}\\docs\\tickets\\live-session-cards.md`
  const paths = recentlyWrittenPaths(
    transcriptOf('user', 'call-1', 'call-2'),
    [read('call-1', `${PROJECT}\\docs\\plans\\tickets-board-and-file-nodes.md`), write('call-2', ticket)],
    RUNNING
  )
  assert.deepEqual(paths, [ticket])
})

test('the same file written twice in a turn is reported once', () => {
  const ticket = `${PROJECT}/docs/tickets/x.md`
  const paths = recentlyWrittenPaths(
    transcriptOf('user', 'call-1', 'call-2'),
    [write('call-1', ticket), write('call-2', ticket)],
    RUNNING
  )
  assert.deepEqual(paths, [ticket])
})

test('a running turn keeps the turn before it, and nothing older', () => {
  const paths = recentlyWrittenPaths(
    transcriptOf('user', 'old', 'user', 'previous', 'user', 'current'),
    [
      write('old', `${PROJECT}/docs/tickets/old.md`),
      write('previous', `${PROJECT}/docs/tickets/previous.md`),
      write('current', `${PROJECT}/docs/tickets/current.md`)
    ],
    RUNNING
  )
  assert.deepEqual(paths, [`${PROJECT}/docs/tickets/previous.md`, `${PROJECT}/docs/tickets/current.md`])
})

test('between turns only the turn that just finished counts', () => {
  const paths = recentlyWrittenPaths(
    transcriptOf('user', 'previous', 'user', 'finished'),
    [
      write('previous', `${PROJECT}/docs/tickets/previous.md`),
      write('finished', `${PROJECT}/docs/tickets/finished.md`)
    ],
    BETWEEN_TURNS
  )
  assert.deepEqual(paths, [`${PROJECT}/docs/tickets/finished.md`])
})

test('a steer sent mid-turn does not hide what the turn had already written', () => {
  // The captain's messages are the only boundaries a replayed transcript has, but a steer is one
  // too - so the turn's observed start, index 1 here, is what the window has to respect.
  const transcript = transcriptOf('user', 'early', 'user', 'late')
  const activities = [
    write('early', `${PROJECT}/docs/tickets/early.md`),
    write('late', `${PROJECT}/docs/tickets/late.md`)
  ]
  assert.deepEqual(recentlyWrittenPaths(transcript, activities, { working: true, startedAt: 1 }), [
    `${PROJECT}/docs/tickets/early.md`,
    `${PROJECT}/docs/tickets/late.md`
  ])
  // Without an observed start - a replayed transcript - the messages are all there is to go on.
  assert.deepEqual(recentlyWrittenPaths(transcript, activities, BETWEEN_TURNS), [`${PROJECT}/docs/tickets/late.md`])
})

test('an activity the transcript never placed is not reported', () => {
  const paths = recentlyWrittenPaths(
    transcriptOf('user', 'call-1'),
    [write('call-1', `${PROJECT}/docs/tickets/x.md`), write('unplaced', `${PROJECT}/docs/tickets/y.md`)],
    RUNNING
  )
  assert.deepEqual(paths, [`${PROJECT}/docs/tickets/x.md`])
})

test('the tickets folder is the default unless the project names one it may use', () => {
  const root = 'D:/Development/Toucan'
  assert.equal(ticketsRootFor(PROJECT), `${root}/docs/tickets`)
  assert.equal(ticketsRootFor(PROJECT, 'work/items'), `${root}/work/items`)
  assert.equal(ticketsRootFor(PROJECT, 'work\\items\\'), `${root}/work/items`)
  // An override that climbs out of the checkout is ignored, exactly as main's resolver ignores it.
  assert.equal(ticketsRootFor(PROJECT, '../elsewhere'), `${root}/docs/tickets`)
  assert.equal(ticketsRootFor(PROJECT, 'C:\\elsewhere'), `${root}/docs/tickets`)
})

const SCOPE = { roots: [ticketsRootFor(PROJECT)], workingDirectory: PROJECT }

test('a ticket path yields its slug whichever separator and drive case it arrives in', () => {
  assert.equal(ticketSlugFor(`${PROJECT}\\docs\\tickets\\live-session-cards.md`, SCOPE), 'live-session-cards')
  assert.equal(ticketSlugFor(`${PROJECT}/docs/tickets/live-session-cards.md`, SCOPE), 'live-session-cards')
  assert.equal(ticketSlugFor('d:/development/toucan/docs/tickets/x.md', SCOPE), 'x')
})

test('a relative path is resolved against the directory the session runs in', () => {
  assert.equal(ticketSlugFor('docs/tickets/x.md', SCOPE), 'x')
  assert.equal(ticketSlugFor('docs\\tickets\\x.md', SCOPE), 'x')
})

test('anything that is not a flat ticket file in the folder is ignored', () => {
  const outside = (path: string): string | undefined => ticketSlugFor(path, SCOPE)
  assert.equal(outside(`${PROJECT}/src/main/index.ts`), undefined)
  assert.equal(outside(`${PROJECT}/docs/plans/x.md`), undefined)
  assert.equal(outside('D:/Development/Other/docs/tickets/x.md'), undefined)
  // A near miss: the folder name is a prefix of another folder's.
  assert.equal(outside(`${PROJECT}/docs/tickets-archive/x.md`), undefined)
  assert.equal(outside(`${PROJECT}/docs/tickets/nested/x.md`), undefined)
  assert.equal(outside(`${PROJECT}/docs/tickets/x.txt`), undefined)
  assert.equal(outside(`${PROJECT}/docs/tickets/Not A Slug.md`), undefined)
})

const ACTIVE = { id: 'project-1', path: PROJECT }

function node(id: string, overrides: Partial<TicketSessionNode['data']> = {}): TicketSessionNode {
  return {
    id,
    data: { label: id, kind: 'claude', workingDirectory: PROJECT, projectId: ACTIVE.id, ...overrides }
  }
}

function report(paths: string[], working = false): TicketActivityReport {
  return { paths, working }
}

test('a session that wrote a ticket becomes the chip on that card', () => {
  const sessions = ticketSessionsFromNodes(
    [node('node-1', { label: 'Claude 1' })],
    { 'node-1': report([`${PROJECT}\\docs\\tickets\\x.md`], true) },
    ACTIVE
  )
  assert.deepEqual(sessions.get('files:x'), { nodeId: 'node-1', label: 'Claude 1', kind: 'claude', working: true })
  assert.equal(sessions.size, 1)
})

test('a session running in a worktree writes the same ticket', () => {
  const worktree = 'D:\\Development\\Toucan-worktrees\\live-cards'
  const sessions = ticketSessionsFromNodes(
    [node('node-1', { workingDirectory: worktree })],
    { 'node-1': report([`${worktree}\\docs\\tickets\\x.md`]) },
    ACTIVE
  )
  assert.equal(sessions.get('files:x')?.nodeId, 'node-1')
})

test('a working session outranks one that merely touched the ticket last turn', () => {
  const paths = [`${PROJECT}/docs/tickets/x.md`]
  const sessions = ticketSessionsFromNodes(
    [node('idle'), node('busy')],
    { idle: report(paths), busy: report(paths, true) },
    ACTIVE
  )
  assert.equal(sessions.get('files:x')?.nodeId, 'busy')
})

test('a session belonging to another project is not on this board', () => {
  const atlas = 'D:\\Development\\Atlas'
  const sessions = ticketSessionsFromNodes(
    [node('node-1', { projectId: 'atlas', workingDirectory: atlas })],
    { 'node-1': report([`${atlas}\\docs\\tickets\\x.md`]) },
    ACTIVE
  )
  assert.equal(sessions.size, 0)
})

test('a tickets folder the project renamed is honoured', () => {
  const sessions = ticketSessionsFromNodes(
    [node('node-1')],
    { 'node-1': report([`${PROJECT}/work/items/x.md`]) },
    {
      ...ACTIVE,
      ticketsDirectory: 'work/items'
    }
  )
  assert.equal(sessions.get('files:x')?.nodeId, 'node-1')
})

test('a session that wrote nothing under the tickets folder produces no chip', () => {
  const sessions = ticketSessionsFromNodes(
    [node('node-1')],
    { 'node-1': report([`${PROJECT}/src/main/index.ts`]) },
    ACTIVE
  )
  assert.equal(sessions.size, 0)
})
