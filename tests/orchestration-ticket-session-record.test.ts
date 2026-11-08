import { describe, expect, it } from 'vitest'
import {
  abandonTicketSession,
  applyPlan,
  recordTicketSession,
  updateTicketSession,
  type OrchestrationRecord
} from '../src/shared/orchestration'

// Issue #1: a spawn records its session as soon as the canvas holds it, and takes it back if the
// start fails.
describe('a ticket session recorded while it starts', () => {
  const base = (): OrchestrationRecord =>
    applyPlan(
      undefined,
      { task: 'x', targetBranch: 'main', tickets: [{ id: '1', title: 'one', blockedBy: [] }] },
      { provider: 'claude', conversationId: 'orch', projectPath: 'D:\\project' },
      'then'
    ).record!
  const early = { nodeId: 'node-1', worktreePath: 'D:\\wt', branch: 'ticket/1' }

  it('is a starting run, then settles with its conversation id', () => {
    const recorded = recordTicketSession(base(), '1', early, 'now', undefined, 'starting')
    expect(recorded.tickets[0].session).toEqual(early)
    expect(recorded.tickets[0].runs).toEqual([{ state: 'starting', provider: 'claude', ...early }])

    const settled = updateTicketSession(recorded, '1', { ...early, conversationId: 'c-1' }, 'later', 'started')
    expect(settled.tickets[0].session).toEqual({ ...early, conversationId: 'c-1' })
    expect(settled.tickets[0].runs).toEqual([{ conversationId: 'c-1', provider: 'claude', ...early }])
  })

  it('leaves a ticket that moved on to another node alone', () => {
    const recorded = recordTicketSession(base(), '1', early, 'now', undefined, 'starting')
    const updated = updateTicketSession(recorded, '1', { ...early, nodeId: 'node-2' }, 'later', 'started')
    expect(updated.tickets).toEqual(recorded.tickets)
  })

  it('is taken back to what the ticket had before when the start fails', () => {
    const first = recordTicketSession(base(), '1', { ...early, nodeId: 'node-0', conversationId: 'c-0' }, 'a')
    const before = { session: first.tickets[0].session, runs: first.tickets[0].runs }
    const retry = recordTicketSession(first, '1', early, 'b', undefined, 'starting')
    expect(retry.tickets[0].runs).toHaveLength(2)

    const abandoned = abandonTicketSession(retry, '1', 'node-1', before, 'c')
    expect(abandoned.tickets[0].session).toEqual(before.session)
    expect(abandoned.tickets[0].runs).toEqual(before.runs)

    const fresh = abandonTicketSession(
      recordTicketSession(base(), '1', early, 'b', undefined, 'starting'),
      '1',
      'node-1',
      {},
      'c'
    )
    expect(fresh.tickets[0]).not.toHaveProperty('session')
    expect(fresh.tickets[0]).not.toHaveProperty('runs')
  })
})
