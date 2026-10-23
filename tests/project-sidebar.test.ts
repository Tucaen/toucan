import { strict as assert } from 'node:assert'
import { test } from 'vitest'
import {
  createSessionCanvasNode,
  createWorktreeCanvasNode,
  type CanvasNode,
  type TerminalCanvasNode,
  type WorktreeCanvasNode
} from '../src/renderer/src/canvas-workspace'
import {
  projectOfSelection,
  projectSidebarSummaries,
  sidebarSummaryFor,
  type SidebarProjectSummary,
  type SidebarSessionRow,
  type SidebarWorktreeRow
} from '../src/renderer/src/project-sidebar'
import type { WorkspaceProject } from '../src/shared/workspace'

const TOUCAN: WorkspaceProject = { id: 'toucan', name: 'Toucan', path: 'D:\\Development\\toucan', color: '#8ab4f8' }
const OTHER: WorkspaceProject = { id: 'other', name: 'Other', path: 'D:\\Development\\other', color: '#f28b82' }

const noop = (): undefined => undefined
const sessionCallbacks = {
  onStatusChange: noop,
  onConversationId: noop,
  onTitleChange: async () => true,
  onFocusModeChange: noop,
  onDraftChange: noop,
  onPermissionModeChange: noop,
  onModelChange: noop,
  onResume: noop
}

function chat(id: string, project: WorkspaceProject, selected: boolean): TerminalCanvasNode {
  return {
    ...createSessionCanvasNode(
      { id, kind: 'claude', label: id, position: { x: 0, y: 0 }, launchMode: 'new' },
      project,
      undefined,
      sessionCallbacks
    ),
    selected
  }
}

test('a selected chat names its own project', () => {
  assert.equal(projectOfSelection([chat('a', TOUCAN, false), chat('b', OTHER, true)]), 'other')
})

test('several selected nodes of one project still name it', () => {
  assert.equal(projectOfSelection([chat('a', OTHER, true), chat('b', OTHER, true), chat('c', TOUCAN, false)]), 'other')
})

test('nothing selected, or a selection spanning projects, names no project', () => {
  assert.equal(projectOfSelection([chat('a', TOUCAN, false), chat('b', OTHER, false)]), undefined)
  assert.equal(projectOfSelection([chat('a', TOUCAN, true), chat('b', OTHER, true)]), undefined)
})

const worktreeCallbacks = {
  ...sessionCallbacks,
  onRemoveWorktree: noop,
  onCreateNodeInWorktree: noop,
  onRunSetupCommand: noop,
  onOpenDiff: noop,
  onViewportChange: noop,
  onToggleCollapsed: noop
}

function worktree(worktreeId: string, project: WorkspaceProject): WorktreeCanvasNode {
  return createWorktreeCanvasNode(
    {
      worktreeId,
      branch: `ticket/${worktreeId}`,
      path: `D:\\Worktrees\\${worktreeId}`,
      baseRef: 'main',
      createdAt: '2026-09-09T09:00:00.000Z',
      position: { x: 0, y: 0 }
    },
    project,
    worktreeCallbacks
  )
}

/** A chat, optionally on a worktree, optionally an orchestrator or one a given orchestrator node spawned. */
function chatIn(
  id: string,
  project: WorkspaceProject,
  options: { in?: WorktreeCanvasNode; role?: 'orchestrator'; orchestratedBy?: string } = {}
): TerminalCanvasNode {
  return createSessionCanvasNode(
    {
      id,
      kind: 'claude',
      label: id,
      position: { x: 0, y: 0 },
      launchMode: 'new',
      role: options.role,
      orchestratedBy: options.orchestratedBy
        ? { nodeId: options.orchestratedBy, conversationId: `conv-${options.orchestratedBy}`, provider: 'claude' }
        : undefined
    },
    project,
    options.in?.data,
    sessionCallbacks
  )
}

function summaryOf(nodes: CanvasNode[], project = TOUCAN): SidebarProjectSummary {
  return sidebarSummaryFor(projectSidebarSummaries(nodes, {}), project.id)
}

const topLevelBranches = (nodes: CanvasNode[]): string[] => summaryOf(nodes).worktrees.map((row) => row.branch)

/** Every worktree row the summary renders, wherever it is nested. */
function renderedBranches(summary: SidebarProjectSummary): string[] {
  const sessionBranches = (sessions: SidebarSessionRow[]): string[] =>
    sessions.flatMap((session) => session.ticketWorktrees.flatMap(rowBranches))
  const rowBranches = (row: SidebarWorktreeRow): string[] => [row.branch, ...sessionBranches(row.sessions)]
  return [...summary.worktrees.flatMap(rowBranches), ...sessionBranches(summary.sessions)].sort()
}

test('a ticket worktree nests under the orchestrator whose ticket session runs in it', () => {
  const ticket = worktree('1', TOUCAN)
  const summary = summaryOf([
    ticket,
    chatIn('orch', TOUCAN, { role: 'orchestrator' }),
    chatIn('ticket-chat', TOUCAN, { in: ticket, orchestratedBy: 'orch' })
  ])

  assert.deepEqual(summary.worktrees, [])
  const [orchestrator] = summary.sessions
  assert.deepEqual(
    orchestrator.ticketWorktrees.map((row) => [row.branch, row.sessions.map((session) => session.id)]),
    [['ticket/1', ['ticket-chat']]]
  )
  // Nesting moves a row; it never changes what the sidebar counts.
  assert.equal(summary.nodeCount, 3)
  assert.deepEqual([...summary.sessionNodeIds].sort(), ['orch', 'ticket-chat'])
})

test('nesting does not depend on node order', () => {
  const ticket = worktree('1', TOUCAN)
  assert.deepEqual(
    topLevelBranches([
      chatIn('ticket-chat', TOUCAN, { in: ticket, orchestratedBy: 'orch' }),
      chatIn('orch', TOUCAN, { role: 'orchestrator' }),
      ticket
    ]),
    []
  )
})

test('worktrees without an orchestrator owner stay top-level, exactly as before', () => {
  const plain = worktree('plain', TOUCAN)
  const ticket = worktree('1', TOUCAN)
  const summary = summaryOf([
    plain,
    ticket,
    chatIn('orch', TOUCAN, { role: 'orchestrator' }),
    chatIn('mine', TOUCAN, { in: plain }),
    chatIn('ticket-chat', TOUCAN, { in: ticket, orchestratedBy: 'orch' })
  ])
  assert.deepEqual(
    summary.worktrees.map((row) => [row.branch, row.sessions.map((session) => session.id)]),
    [['ticket/plain', ['mine']]]
  )
  assert.deepEqual(
    summary.sessions.map((session) => [session.id, session.ticketWorktrees.length]),
    [['orch', 1]]
  )
})

test('a worktree falls back to top-level when its orchestrator node is gone', () => {
  const ticket = worktree('1', TOUCAN)
  assert.deepEqual(topLevelBranches([ticket, chatIn('ticket-chat', TOUCAN, { in: ticket, orchestratedBy: 'orch' })]), [
    'ticket/1'
  ])
})

test('a cleaned-up ticket worktree leaves its orchestrator with no children', () => {
  const ticket = worktree('1', TOUCAN)
  const orchestrator = chatIn('orch', TOUCAN, { role: 'orchestrator' })
  const ticketChat = chatIn('t', TOUCAN, { in: ticket, orchestratedBy: 'orch' })
  assert.equal(summaryOf([orchestrator, ticket, ticketChat]).sessions[0].ticketWorktrees.length, 1)

  const after = summaryOf([orchestrator])
  assert.deepEqual(after.sessions[0].ticketWorktrees, [])
  assert.deepEqual(after.worktrees, [])
})

test('only an orchestrator session row is flagged as one', () => {
  const summary = summaryOf([chatIn('orch', TOUCAN, { role: 'orchestrator' }), chatIn('plain', TOUCAN)])
  assert.deepEqual(
    summary.sessions.map((session) => [session.id, session.orchestrator === true]),
    [
      ['orch', true],
      ['plain', false]
    ]
  )
})

test('a link to a node that is not an orchestrator, or sits in another project, owns nothing', () => {
  const ticket = worktree('1', TOUCAN)
  const spawned = chatIn('t', TOUCAN, { in: ticket, orchestratedBy: 'orch' })
  assert.deepEqual(topLevelBranches([ticket, chatIn('orch', TOUCAN), spawned]), ['ticket/1'])
  assert.deepEqual(topLevelBranches([ticket, chatIn('orch', OTHER, { role: 'orchestrator' }), spawned]), ['ticket/1'])
})

test('a worktree is nested once, under the orchestrator of its first ticket session when they disagree', () => {
  const ticket = worktree('1', TOUCAN)
  const summary = summaryOf([
    ticket,
    chatIn('orch-a', TOUCAN, { role: 'orchestrator' }),
    chatIn('orch-b', TOUCAN, { role: 'orchestrator' }),
    chatIn('t-b', TOUCAN, { in: ticket, orchestratedBy: 'orch-b' }),
    chatIn('t-a', TOUCAN, { in: ticket, orchestratedBy: 'orch-a' })
  ])
  assert.deepEqual(
    summary.sessions.map((session) => [session.id, session.ticketWorktrees.length]),
    [
      ['orch-a', 0],
      ['orch-b', 1]
    ]
  )
})

test('an orchestrator living in a worktree shows its ticket worktrees under its own row there', () => {
  const home = worktree('home', TOUCAN)
  const ticket = worktree('1', TOUCAN)
  const summary = summaryOf([
    home,
    ticket,
    chatIn('orch', TOUCAN, { in: home, role: 'orchestrator' }),
    chatIn('t', TOUCAN, { in: ticket, orchestratedBy: 'orch' })
  ])
  assert.deepEqual(
    summary.worktrees.map((row) => row.branch),
    ['ticket/home']
  )
  assert.deepEqual(
    summary.worktrees[0].sessions.map((session) => [session.id, session.ticketWorktrees.map((row) => row.branch)]),
    [['orch', ['ticket/1']]]
  )
})

test('ownership that would loop never hides a worktree', () => {
  const self = worktree('self', TOUCAN)
  const a = worktree('a', TOUCAN)
  const b = worktree('b', TOUCAN)
  const summary = summaryOf([
    self,
    a,
    b,
    // An orchestrator inside the worktree its own ticket session runs in.
    chatIn('orch-self', TOUCAN, { in: self, role: 'orchestrator' }),
    chatIn('t-self', TOUCAN, { in: self, orchestratedBy: 'orch-self' }),
    // Two orchestrators, each living in a worktree the other one owns.
    chatIn('orch-a', TOUCAN, { in: b, role: 'orchestrator' }),
    chatIn('orch-b', TOUCAN, { in: a, role: 'orchestrator' }),
    chatIn('t-a', TOUCAN, { in: a, orchestratedBy: 'orch-a' }),
    chatIn('t-b', TOUCAN, { in: b, orchestratedBy: 'orch-b' })
  ])
  assert.deepEqual(renderedBranches(summary), ['ticket/a', 'ticket/b', 'ticket/self'])
  assert.ok(summary.worktrees.length > 0, 'a loop surfaces at the top level')
})
