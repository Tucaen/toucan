import { fireEvent, render, within } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { ChatView, type ChatViewProps } from '../src/renderer/src/ChatNode'
import type { AgentActivity, AgentPlanEntry } from '../src/shared/agent'

const baseChatViewProps: ChatViewProps = {
  provider: 'claude',
  messages: [],
  activities: [],
  plan: [],
  approval: null,
  authMethods: [],
  authLink: null,
  reauthenticating: false,
  status: 'ready',
  draft: '',
  imageSupport: false,
  attachments: [],
  setDraft: vi.fn(),
  addImages: vi.fn(),
  removeAttachment: vi.fn(),
  submit: vi.fn(),
  cancel: vi.fn(),
  authenticate: vi.fn(),
  openAuthLink: vi.fn(),
  resolveApproval: vi.fn(),
  sendMessage: vi.fn(),
  answerDecision: vi.fn(),
  queued: [],
  editQueued: vi.fn(),
  withdrawQueued: vi.fn(),
  sendQueuedNow: vi.fn(),
  focusMode: false,
  setFocusMode: vi.fn()
}

function renderTranscript(activities: AgentActivity[], plan: AgentPlanEntry[] = []): HTMLElement {
  const { container } = render(
    <ChatView
      {...baseChatViewProps}
      activities={activities}
      plan={plan}
      workspaceRoots={['D:\\Development\\ADE']}
    />
  )
  return container.querySelector<HTMLElement>('.chat-scroll') as HTMLElement
}

function renderCard(activity: AgentActivity): HTMLElement {
  const card = renderTranscript([activity]).querySelector<HTMLElement>('.activity-card')
  expect(card).not.toBeNull()
  return card as HTMLElement
}

describe('task, plan, skill and MCP tool cards', () => {
  test("a running delegation shows the subagent's own steps progressing, not one opaque entry", () => {
    const transcript = renderTranscript([
      {
        id: 'task-1',
        kind: 'other',
        toolName: 'Task',
        subagent: true,
        status: 'in_progress',
        rawInput: { subagent_type: 'Explore', description: 'Find the plan rail', prompt: 'Search the renderer.' },
        startedAt: 0
      },
      {
        id: 'grep-1',
        kind: 'search',
        toolName: 'Grep',
        parentToolCallId: 'task-1',
        status: 'completed',
        rawInput: { pattern: 'props.plan' },
        content: 'D:\\Development\\ADE\\src\\renderer\\src\\ChatNode.tsx:1119:props.plan.length',
        startedAt: 0,
        endedAt: 50
      },
      {
        id: 'read-1',
        kind: 'read',
        toolName: 'Read',
        parentToolCallId: 'task-1',
        status: 'in_progress',
        rawInput: { file_path: 'D:\\Development\\ADE\\src\\renderer\\src\\ChatNode.tsx' },
        startedAt: 50
      }
    ])

    // The subagent's calls belong to the delegation, so exactly one card is at the top level.
    const cards = transcript.querySelectorAll('.activity-card')
    expect(cards).toHaveLength(1)
    expect((cards[0] as HTMLElement).dataset.family).toBe('subagent-task')

    const header = within(cards[0] as HTMLElement).getByRole('button')
    expect(header.textContent).toContain('Explore')
    expect(header.textContent).toContain('Explore — Find the plan rail')
    // The whole point: progress is visible without expanding, and it is not just "running".
    expect(header.textContent).toContain('1 of 2 steps')

    const steps = cards[0].querySelectorAll('.subagent-step')
    expect(steps).toHaveLength(2)
    expect(steps[0].textContent).toContain('props.plan — 1 match in 1 file')
    expect(steps[0].textContent).toContain('done')
    expect(steps[1].textContent).toContain('src/renderer/src/ChatNode.tsx')
    expect(steps[1].textContent).toContain('running')
  })

  test('a delegation that has not reported a step yet says so instead of showing nothing', () => {
    const card = renderCard({
      id: 'task-1',
      kind: 'other',
      toolName: 'Task',
      subagent: true,
      status: 'in_progress',
      rawInput: { subagent_type: 'general-purpose', description: 'Audit the tests' },
      startedAt: 0
    })

    expect(card.textContent).toContain('Waiting for the subagent')
    expect(card.querySelector('.subagent-progress')).toBeNull()
  })

  test('a plan write the current plan already shows never appears beside it as a second copy', () => {
    const write: AgentActivity = {
      id: 'todo-1',
      kind: 'other',
      toolName: 'TodoWrite',
      status: 'completed',
      rawInput: { todos: [{ content: 'Ship the cards', status: 'in_progress' }] },
      startedAt: 0,
      endedAt: 10
    }
    const plan: AgentPlanEntry[] = [{ content: 'Ship the cards', priority: 'high', status: 'in_progress' }]

    const folded = renderTranscript([write], plan)
    expect(folded.querySelectorAll('.activity-card[data-family="plan-update"]')).toHaveLength(0)
    expect(folded.querySelectorAll('.activity-card[data-family="plan"]')).toHaveLength(1)
    expect(folded.querySelectorAll('.plan-list')).toHaveLength(1)

    // A write that was refused is not what the current plan shows, so it keeps its own card.
    const refused = renderTranscript([{ ...write, status: 'failed' }], plan)
    const card = refused.querySelector<HTMLElement>('.activity-card[data-family="plan-update"]')
    expect(card?.dataset.family).toBe('plan-update')
    expect(card?.textContent).toContain('Updated the plan — 1 step, 0 done')
  })

  test('a skill invocation names the skill and what the session said it is for', () => {
    const { container } = render(
      <ChatView
        {...baseChatViewProps}
        activities={[{
          id: 'skill-1',
          kind: 'other',
          toolName: 'Skill',
          status: 'completed',
          rawInput: { skill: 'code-review', args: 'since main' },
          content: 'Reviewing 7 changed files.',
          startedAt: 0,
          endedAt: 10
        }]}
        commands={[{ name: 'code-review', description: 'Review the changes since a fixed point.' }]}
        workspaceRoots={['D:\\Development\\ADE']}
      />
    )
    const card = container.querySelector<HTMLElement>('.activity-card') as HTMLElement

    expect(card.dataset.family).toBe('skill-invocation')
    const header = within(card).getByRole('button', { expanded: false })
    expect(header.textContent).toContain('/code-review since main')

    fireEvent.click(header)
    expect(card.textContent).toContain('Review the changes since a fixed point.')
    expect(card.textContent).toContain('Reviewing 7 changed files.')
  })

  test('a codex delegation shows the interactions on its thread as its progress', () => {
    const interaction = (id: string, activityKind: string, status: AgentActivity['status']): AgentActivity => ({
      id,
      kind: 'other',
      status,
      subagent: true,
      rawInput: { agentThreadId: 'thread-7', agentPath: '.codex/agents/reviewer.md', activityKind },
      startedAt: 0
    })
    const transcript = renderTranscript([
      interaction('sub-1', 'started', 'completed'),
      interaction('sub-2', 'interacted', 'completed'),
      interaction('sub-3', 'interacted', 'in_progress')
    ])

    const cards = transcript.querySelectorAll('.activity-card')
    expect(cards).toHaveLength(1)
    expect((cards[0] as HTMLElement).dataset.family).toBe('subagent-task')
    const header = within(cards[0] as HTMLElement).getByRole('button')
    // The `started` call is the one that settles first, so its card is collapsed by default -
    // the progress chip has to carry the whole story from the header.
    expect(header.textContent).toContain('reviewer.md — Started')
    expect(header.textContent).toContain('1 of 2 steps')

    fireEvent.click(header)
    const steps = cards[0].querySelectorAll('.subagent-step')
    expect(steps).toHaveLength(2)
    expect(steps[1].textContent).toContain('running')
  })

  test('an MCP call shows its server apart from its tool, so it cannot pass for a built-in', () => {
    const card = renderCard({
      id: 'mcp-1',
      kind: 'other',
      toolName: 'mcp__linear__create_issue',
      status: 'completed',
      rawInput: { title: 'Card work' },
      content: 'Created ENG-7',
      startedAt: 0,
      endedAt: 10
    })

    expect(card.dataset.family).toBe('mcp-tool-call')
    const header = within(card).getByRole('button', { expanded: false })
    expect(header.querySelector('.mcp-server')?.textContent).toBe('linear')
    expect(header.querySelector('.mcp-tool')?.textContent).toBe('create_issue')
    expect(header.textContent).toContain('MCP')

    fireEvent.click(header)
    expect(card.textContent).toContain('Provided by the linear MCP server')
    expect(card.querySelector('.mcp-arguments')?.textContent).toContain('"title": "Card work"')
    expect(card.querySelector('.mcp-result')?.textContent).toContain('Created ENG-7')
  })

  test("an MCP tool whose bare name matches a built-in still renders as the server's tool", () => {
    const card = renderCard({
      id: 'mcp-2',
      kind: 'search',
      toolName: 'mcp__docs__grep',
      status: 'completed',
      rawInput: { pattern: 'useAgentConversation' },
      content: 'docs/agents.md:4:useAgentConversation',
      startedAt: 0,
      endedAt: 10
    })

    expect(card.dataset.family).toBe('mcp-tool-call')
    expect(card.querySelector('.mcp-server')?.textContent).toBe('docs')
  })
})
