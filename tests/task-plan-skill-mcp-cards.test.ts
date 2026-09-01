import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import type { AgentActivity } from '../src/shared/agent'
import { mcpArgumentLines, mcpResultText, parseMcpToolCall } from '../src/renderer/src/mcp-tool-call'
import { isPlanUpdateFoldedIntoRail, parsePlanUpdate, planUpdateSummary } from '../src/renderer/src/plan-update'
import { parseSkillInvocation, skillDescription, skillInvocationSummary } from '../src/renderer/src/skill-invocation'
import {
  indexSubagentActivities,
  parseSubagentTask,
  subagentProgress,
  subagentProgressLabel,
  subagentTaskSummary
} from '../src/renderer/src/subagent-task'
import { worklogActivities } from '../src/renderer/src/worklog-activities'

function activity(overrides: Partial<AgentActivity> & { id: string }): AgentActivity {
  return { status: 'completed', ...overrides }
}

test('a Task call names the agent it delegated to and what it asked for', () => {
  const task = parseSubagentTask(
    activity({
      id: 'task-1',
      toolName: 'Task',
      subagent: true,
      rawInput: {
        subagent_type: 'Explore',
        description: 'Find the plan rail',
        prompt: 'Search the renderer for where props.plan is drawn.',
        model: 'sonnet'
      }
    })
  )

  assert.deepEqual(task, {
    agentType: 'Explore',
    description: 'Find the plan rail',
    prompt: 'Search the renderer for where props.plan is drawn.',
    model: 'sonnet'
  })
  assert.equal(subagentTaskSummary(task!, activity({ id: 'task-1' })), 'Explore — Find the plan rail')
})

test("a codex subagent activity takes its agent name from the agent file's leaf", () => {
  const task = parseSubagentTask(
    activity({
      id: 'sub-1',
      subagent: true,
      rawInput: { agentPath: '.codex/agents/reviewer.md', activityKind: 'started' }
    })
  )

  assert.equal(task?.agentType, 'reviewer.md')
})

test('a third-party MCP tool whose bare name is Task is not mistaken for a delegation', () => {
  const call = activity({
    id: 'mcp-1',
    toolName: 'mcp__tracker__task',
    rawInput: { id: 'ENG-4' }
  })

  assert.equal(parseSubagentTask(call), null)
  assert.deepEqual(parseMcpToolCall(call), { server: 'tracker', tool: 'task', arguments: { id: 'ENG-4' } })
})

test("a delegation's progress counts its own steps and names the one still running", () => {
  const children = [
    activity({ id: 'a', title: 'Grep for plan', status: 'completed' }),
    activity({ id: 'b', title: 'Read ChatNode.tsx', status: 'completed' }),
    activity({ id: 'c', title: 'Read styles.css', status: 'in_progress' })
  ]

  const progress = subagentProgress(children)
  assert.deepEqual(progress, { total: 3, settled: 2, current: 'Read styles.css' })
  assert.equal(subagentProgressLabel(progress!), '2 of 3 steps')
  assert.equal(subagentProgress([]), undefined)
  assert.equal(
    subagentProgressLabel(subagentProgress(children.map((child) => ({ ...child, status: 'completed' })))!),
    '3 steps'
  )
})

test("a subagent's tool calls group under the delegation, and orphans keep their own card", () => {
  const activities = [
    activity({ id: 'task-1', toolName: 'Task', subagent: true, status: 'in_progress' }),
    activity({ id: 'grep-1', parentToolCallId: 'task-1' }),
    activity({ id: 'read-1', parentToolCallId: 'task-1' }),
    activity({ id: 'orphan-1', parentToolCallId: 'task-gone' }),
    activity({ id: 'bash-1' })
  ]

  const nested = indexSubagentActivities(activities)
  assert.deepEqual(
    nested.get('task-1')?.map((child) => child.id),
    ['grep-1', 'read-1']
  )
  assert.equal(nested.has('task-gone'), false)
  assert.deepEqual(
    worklogActivities(activities, nested, false).map((entry) => entry.id),
    ['task-1', 'orphan-1', 'bash-1']
  )
})

test('codex reports one delegation as several calls on a thread, and they group into one card', () => {
  // codex-acp never nests: it emits `started`/`interacted`/`interrupted` as separate top-level
  // tool calls sharing an `agentThreadId`, and forwards none of the subagent's own tool calls.
  const codex = (id: string, activityKind: string, status: AgentActivity['status']): AgentActivity =>
    activity({
      id,
      status,
      subagent: true,
      rawInput: { agentThreadId: 'thread-7', agentPath: '.codex/agents/reviewer.md', activityKind }
    })
  const activities = [
    codex('sub-1', 'started', 'completed'),
    codex('sub-2', 'interacted', 'completed'),
    codex('sub-3', 'interacted', 'in_progress'),
    activity({ id: 'other-thread', subagent: true, rawInput: { agentThreadId: 'thread-9' } })
  ]

  const nested = indexSubagentActivities(activities)
  assert.deepEqual(
    nested.get('sub-1')?.map((child) => child.id),
    ['sub-2', 'sub-3']
  )
  assert.deepEqual(
    worklogActivities(activities, nested, false).map((entry) => entry.id),
    ['sub-1', 'other-thread']
  )
  // The acceptance criterion, on the provider that reports no children at all.
  assert.equal(subagentProgressLabel(subagentProgress(nested.get('sub-1')!)!), '1 of 2 steps')
})

test('a codex interaction keeps its verb, so an interrupt cannot read as a start', () => {
  const started = parseSubagentTask(
    activity({
      id: 'sub-1',
      subagent: true,
      rawInput: { agentPath: '.codex/agents/reviewer.md', activityKind: 'started', agentThreadId: 't7' }
    })
  )!
  const interrupted = parseSubagentTask(
    activity({
      id: 'sub-3',
      subagent: true,
      rawInput: { agentPath: '.codex/agents/reviewer.md', activityKind: 'interrupted', agentThreadId: 't7' }
    })
  )!

  assert.equal(subagentTaskSummary(started, activity({ id: 'sub-1' })), 'reviewer.md — Started')
  assert.equal(subagentTaskSummary(interrupted, activity({ id: 'sub-3' })), 'reviewer.md — Interrupted')
  assert.equal(started.threadId, 't7')
})

test('a plan write the rail already shows is folded out of the worklog, and a refused one is not', () => {
  const approved = activity({ id: 'todo-1', toolName: 'TodoWrite', status: 'completed', rawInput: { todos: [] } })
  const refused = activity({ id: 'todo-2', toolName: 'TodoWrite', status: 'failed', rawInput: { todos: [] } })
  const pending = activity({ id: 'todo-3', toolName: 'TodoWrite', status: 'pending', rawInput: { todos: [] } })

  assert.equal(isPlanUpdateFoldedIntoRail(approved, true), true)
  assert.equal(isPlanUpdateFoldedIntoRail(refused, true), false)
  assert.equal(isPlanUpdateFoldedIntoRail(pending, true), false)
  // With nothing on the rail, folding would be the reason the write left no trace at all.
  assert.equal(isPlanUpdateFoldedIntoRail(approved, false), false)
  assert.deepEqual(
    worklogActivities([approved, refused, pending], new Map(), true).map((entry) => entry.id),
    ['todo-2', 'todo-3']
  )
})

test("a plan write's entries are read from either adapter's spelling", () => {
  const claude = parsePlanUpdate(
    activity({
      id: 'todo-1',
      toolName: 'TodoWrite',
      rawInput: {
        todos: [
          { content: 'Read the issue', status: 'completed' },
          { content: 'Write the card', status: 'in_progress' },
          { content: 'Run the tests', status: 'pending' }
        ]
      }
    })
  )
  const codex = parsePlanUpdate(
    activity({
      id: 'plan-1',
      toolName: 'update_plan',
      rawInput: { plan: [{ step: 'Read the issue', status: 'completed' }] }
    })
  )
  const created = parsePlanUpdate(
    activity({
      id: 'task-create-1',
      toolName: 'TaskCreate',
      rawInput: { subject: 'Ship the cards' }
    })
  )

  assert.equal(planUpdateSummary(claude!), 'Updated the plan — 3 steps, 1 done')
  assert.deepEqual(codex?.entries, [{ content: 'Read the issue', status: 'completed', priority: 'medium' }])
  assert.deepEqual(created?.entries, [{ content: 'Ship the cards', status: 'pending', priority: 'medium' }])
  assert.equal(planUpdateSummary(parsePlanUpdate(activity({ id: 'l', toolName: 'TaskList' }))!), 'Read the plan')
})

test('a skill invocation is named, and a slash command splits its own arguments off', () => {
  const skill = parseSkillInvocation(
    activity({
      id: 'skill-1',
      toolName: 'Skill',
      rawInput: { skill: 'code-review', args: 'since main' }
    })
  )
  const command = parseSkillInvocation(
    activity({
      id: 'command-1',
      toolName: 'SlashCommand',
      rawInput: { command: '/review 91' }
    })
  )

  assert.deepEqual(skill, { name: 'code-review', args: 'since main' })
  assert.equal(skillInvocationSummary(skill!), '/code-review since main')
  assert.deepEqual(command, { name: 'review', args: '91' })
  // Nothing to add over the generic card when the call names no skill at all.
  assert.equal(parseSkillInvocation(activity({ id: 'skill-2', toolName: 'Skill', rawInput: {} })), null)
})

test('why a skill was loaded comes from what the session advertised about it, or from nothing', () => {
  const invocation = parseSkillInvocation(
    activity({
      id: 'skill-1',
      toolName: 'Skill',
      rawInput: { skill: 'code-review' }
    })
  )!
  const commands = [
    { name: 'tdd', description: 'Test-driven development.' },
    { name: '/code-review', description: 'Review the changes since a fixed point.' }
  ]

  assert.equal(skillDescription(invocation, commands), 'Review the changes since a fixed point.')
  // A skill Toucan never saw advertised gets no description rather than a guessed one.
  assert.equal(skillDescription({ name: 'unknown-skill' }, commands), undefined)
})

test('an MCP call keeps its server and its tool apart, whichever adapter reported it', () => {
  const claude = activity({
    id: 'mcp-1',
    toolName: 'mcp__linear__create_issue',
    rawInput: { title: 'Card work', arguments: 'not an envelope' },
    content: 'Created ENG-7'
  })
  const codex = activity({
    id: 'mcp-2',
    title: 'mcp.linear.create_issue',
    kind: 'execute',
    rawInput: { server: 'linear', tool: 'create_issue', arguments: { title: 'Card work' } },
    rawOutput: { result: 'Created ENG-7', error: null }
  })

  assert.deepEqual(parseMcpToolCall(claude), {
    server: 'linear',
    tool: 'create_issue',
    arguments: { title: 'Card work', arguments: 'not an envelope' }
  })
  assert.deepEqual(parseMcpToolCall(codex), {
    server: 'linear',
    tool: 'create_issue',
    arguments: { title: 'Card work' }
  })
  assert.equal(mcpResultText(claude), 'Created ENG-7')
  assert.equal(mcpResultText(codex), 'Created ENG-7')
  assert.deepEqual(mcpArgumentLines(parseMcpToolCall(codex)!), ['{', '  "title": "Card work"', '}'])
  assert.deepEqual(mcpArgumentLines({ server: 'x', tool: 'y', arguments: {} }), [])
})

test('a built-in tool is never claimed by the MCP card', () => {
  assert.equal(parseMcpToolCall(activity({ id: 'read-1', toolName: 'Read', rawInput: { file_path: 'a.ts' } })), null)
  assert.equal(parseMcpToolCall(activity({ id: 'bash-1', title: 'npm test', rawInput: { command: 'npm test' } })), null)
})
