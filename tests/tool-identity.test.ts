import { strict as assert } from 'node:assert'
import { test } from 'vitest'
import type { AgentActivity } from '../src/shared/agent'
import { isDelegationActivity, normalizeToolName, parseMcpToolCall } from '../src/shared/tool-identity'

/**
 * Tool identity is what every card, every evidence read and the delegation chips downstream agree
 * a tool *is*, across three providers that spell the same tool three ways. These are the spellings
 * that must land on one identity, and the near-misses that must not.
 */

function activity(overrides: Partial<AgentActivity> = {}): AgentActivity {
  return { id: 'activity-1', kind: 'tool', status: 'completed', title: 'Tool', ...overrides } as AgentActivity
}

test('a tool name reduces to the bare built-in identity whatever separator the provider used', () => {
  assert.equal(normalizeToolName('Read'), 'read')
  assert.equal(normalizeToolName('shell.exec'), 'exec')
  assert.equal(normalizeToolName('mcp:github:create_issue'), 'createissue')
  assert.equal(normalizeToolName('mcp__github__create_issue'), 'createissue')
  // Digits and punctuation are not identity; two spellings of one tool have to collide.
  assert.equal(normalizeToolName('Bash-2'), 'bash')
  assert.equal(normalizeToolName(undefined), undefined)
  assert.equal(normalizeToolName(''), undefined)
})

test('a name that is nothing but separators still answers rather than throwing', () => {
  assert.equal(normalizeToolName('...'), '')
  assert.equal(normalizeToolName('123'), '')
})

test('a subagent launch is delegation however the provider reported it', () => {
  assert.equal(isDelegationActivity(activity({ toolName: 'Task' })), true)
  assert.equal(isDelegationActivity(activity({ toolName: 'agent' })), true)
  // A declared subagent is delegation even when the tool is named something else entirely.
  assert.equal(isDelegationActivity(activity({ toolName: 'Bash', subagent: 'routine-worker' })), true)
})

test('an MCP tool that merely happens to be called "task" is not delegation', () => {
  // The qualified identity is checked first on purpose: an MCP server is free to expose a `task`
  // tool, and counting its calls as subagent launches would invent delegations that never ran.
  const mcp = activity({ toolName: 'mcp__tracker__task' })
  assert.notEqual(parseMcpToolCall(mcp), null)
  assert.equal(isDelegationActivity(mcp), false)

  assert.equal(isDelegationActivity(activity({ toolName: 'Read' })), false)
  assert.equal(isDelegationActivity(activity({})), false)
})
