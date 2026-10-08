import { strict as assert } from 'node:assert'
import { test } from 'vitest'
import { activeOrchestratedTicketSessionCount } from '../src/main/orchestrated-ticket-sessions'

test('counts live ticket sessions provider-wide from provenance rather than a project-local counter', () => {
  const nodes = [
    { id: 'claude-a', kind: 'claude', orchestratedBy: { nodeId: 'captain-a' } },
    { id: 'claude-b', kind: 'claude', orchestratedBy: { nodeId: 'captain-b' } },
    { id: 'codex', kind: 'codex', orchestratedBy: { nodeId: 'captain-c' } },
    { id: 'ordinary', kind: 'claude' },
    { id: 'exited', kind: 'claude', orchestratedBy: { nodeId: 'captain-d' } }
  ]
  const statuses = new Map([
    ['claude-a', 'working'],
    ['claude-b', 'ready'],
    ['codex', 'starting'],
    ['ordinary', 'working'],
    ['exited', 'exited']
  ] as const)

  assert.equal(
    activeOrchestratedTicketSessionCount(nodes, 'claude', (id) => statuses.get(id)),
    2
  )
  assert.equal(
    activeOrchestratedTicketSessionCount(nodes, 'codex', (id) => statuses.get(id)),
    1
  )
})
