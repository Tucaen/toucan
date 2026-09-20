import { ReactFlowProvider } from '@xyflow/react'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import ChatNode from '../src/renderer/src/ChatNode'
import TicketBoardPanel from '../src/renderer/src/TicketBoardPanel'
import {
  isTerminalCanvasNode,
  restoreCanvasWorkspace,
  type TerminalCanvasNode,
  type TerminalNodeCallbacks,
  type WorktreeNodeCallbacks
} from '../src/renderer/src/canvas-workspace'
import {
  ticketSessionsFromNodes,
  type TicketActivityReport,
  type TicketSessionNode
} from '../src/renderer/src/ticket-activity'
import type { AgentActivity } from '../src/shared/agent'
import type { WorkspaceState } from '../src/shared/terminal'
import type { TicketSource } from '../src/shared/ticket-source'
import { createMockAgentApi, type MockAgentApi } from './dom/agent-api-mock'
import { cardFixture, createMockTicketSkillApi } from './dom/tickets-api-mock'

/**
 * The live session card, end to end but in its two halves: a chat node reporting the ticket files
 * it wrote, and the board turning such reports into a chip that focuses the node. The workspace
 * between them is the real `ticketSessionsByCard`, so what a test proves is a chip a real report
 * would actually produce - not a fixture shaped to fit the panel.
 */

const NODE_ID = 'claude-node'
const PROJECT = 'D:\\Development\\Toucan'
const PROJECT_ID = 'project-1'
const TODAY = '2026-09-04'

function chatNode(callbacks: TerminalNodeCallbacks & WorktreeNodeCallbacks): TerminalCanvasNode {
  const state: WorkspaceState = {
    version: 3,
    projects: [{ id: 'project-1', name: 'Toucan', path: PROJECT, color: '#71a9ff' }],
    activeProjectId: 'project-1',
    sidebarCollapsed: false,
    nodes: [
      {
        id: NODE_ID,
        kind: 'claude',
        label: 'Claude 1',
        projectId: 'project-1',
        position: { x: 0, y: 0 },
        width: 640,
        height: 480,
        conversationId: 'claude-conversation'
      }
    ],
    worktrees: []
  }
  const restored = restoreCanvasWorkspace(state, callbacks)
  const node = restored.nodes.find(isTerminalCanvasNode)
  if (!node) throw new Error('Expected the chat node to restore.')
  return node
}

function renderChat(node: TerminalCanvasNode): void {
  render(
    <ReactFlowProvider>
      <ChatNode
        id={node.id}
        data={node.data}
        type="terminalNode"
        dragging={false}
        zIndex={0}
        selectable
        deletable
        selected={false}
        draggable
        width={640}
        height={480}
        isConnectable={false}
        positionAbsoluteX={0}
        positionAbsoluteY={0}
      />
    </ReactFlowProvider>
  )
}

function callbacks(
  onTicketActivity: TerminalNodeCallbacks['onTicketActivity']
): TerminalNodeCallbacks & WorktreeNodeCallbacks {
  return {
    onStatusChange: vi.fn(),
    onTicketActivity,
    onConversationId: vi.fn(),
    onTitleChange: vi.fn(async () => true),
    onPreview: vi.fn(),
    onFocusModeChange: vi.fn(),
    onDraftChange: vi.fn(),
    onPermissionModeChange: vi.fn(),
    onModelChange: vi.fn(),
    onResume: vi.fn(),
    onRemoveWorktree: vi.fn(),
    onCreateNodeInWorktree: vi.fn(),
    onRunSetupCommand: vi.fn()
  }
}

let mock: MockAgentApi

/** Lets the session's own create() promise settle before any event is emitted. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
  })
}

function writeActivity(id: string, path: string): AgentActivity {
  return { id, toolName: 'Write', title: `Write ${path}`, rawInput: { file_path: path, content: '# ticket' } }
}

beforeEach(() => {
  mock = createMockAgentApi()
  window.agentApi = mock.api
  window.workspaceFilesApi = { index: vi.fn(async () => []) } as never
})

describe('a chat node reporting which tickets it is writing', () => {
  test('a ticket written mid-turn is reported as live, and the turn ending leaves the report standing', async () => {
    const reports: Array<{ nodeId: string; paths: readonly string[]; working: boolean }> = []
    renderChat(chatNode(callbacks((nodeId, report) => void reports.push({ nodeId, ...report }))))
    await settle()

    await act(async () => {
      mock.emit(NODE_ID, { type: 'message', role: 'user', messageId: 'ask', text: 'Implement 146.' })
      mock.emit(NODE_ID, { type: 'status', status: 'working' })
      mock.emit(NODE_ID, {
        type: 'activity',
        activity: writeActivity('call-1', `${PROJECT}\\docs\\tickets\\live-session-cards.md`)
      })
    })

    await waitFor(() =>
      expect(reports.at(-1)).toMatchObject({
        paths: [`${PROJECT}\\docs\\tickets\\live-session-cards.md`],
        working: true
      })
    )

    await act(async () => {
      mock.emit(NODE_ID, { type: 'turn_complete', stopReason: 'end_turn' })
      mock.emit(NODE_ID, { type: 'status', status: 'idle' })
    })

    // The last completed turn still counts: what the session just wrote stays on the card.
    await waitFor(() =>
      expect(reports.at(-1)).toMatchObject({
        paths: [`${PROJECT}\\docs\\tickets\\live-session-cards.md`],
        working: false
      })
    )
  })

  test('a session that only read files reports nothing to report', async () => {
    const onTicketActivity = vi.fn()
    renderChat(chatNode(callbacks(onTicketActivity)))
    await settle()

    await act(async () => {
      mock.emit(NODE_ID, { type: 'message', role: 'user', messageId: 'ask', text: 'What is in 146?' })
      mock.emit(NODE_ID, { type: 'status', status: 'working' })
      mock.emit(NODE_ID, {
        type: 'activity',
        activity: { id: 'call-1', toolName: 'Read', rawInput: { file_path: `${PROJECT}/docs/tickets/x.md` } }
      })
    })

    await waitFor(() => expect(onTicketActivity).toHaveBeenCalled())
    for (const call of onTicketActivity.mock.calls) expect(call[1].paths).toEqual([])
  })
})

function boardSource(): TicketSource {
  return {
    id: 'files',
    label: 'Files',
    list: async () => ({
      cards: [
        // Both in the same state, so the board's one ticket pane holds them side by side: what
        // separates them here is which one a session actually wrote, not where they sit.
        cardFixture({ id: 'live-session-cards', title: 'Live session cards', status: 'in-progress' }),
        cardFixture({ id: 'file-node', title: 'File node', status: 'in-progress' })
      ],
      diagnostics: []
    }),
    setStatus: async () => ({ ok: false as const, code: 'refused', message: 'Not in this test.' })
  }
}

async function renderBoard(
  report: TicketActivityReport,
  onFocusSession = vi.fn()
): Promise<{ onFocusSession: ReturnType<typeof vi.fn> }> {
  const node: TicketSessionNode = {
    id: NODE_ID,
    data: { label: 'Claude 1', kind: 'claude', workingDirectory: PROJECT, projectId: PROJECT_ID }
  }
  render(
    <TicketBoardPanel
      panel={{ open: true, width: 520 }}
      workspaceWidth={1920}
      projectPath={PROJECT}
      projectName="Toucan"
      sources={[boardSource()]}
      skillApi={createMockTicketSkillApi()}
      today={TODAY}
      sessions={ticketSessionsFromNodes([node], { [NODE_ID]: report }, { id: PROJECT_ID, path: PROJECT })}
      onFocusSession={onFocusSession}
      onPanelChange={vi.fn()}
    />
  )
  await screen.findByText('Live session cards')
  return { onFocusSession }
}

function wrote(working: boolean): TicketActivityReport {
  return { working, paths: [`${PROJECT}\\docs\\tickets\\live-session-cards.md`] }
}

const cardOf = (title: string): HTMLElement => screen.getByText(title).closest('.ticket-card') as HTMLElement

describe('the board chip for a session that is on a ticket', () => {
  test('the chip names the session, carries its provider icon, and hands up the node id', async () => {
    const { onFocusSession } = await renderBoard(wrote(true))

    const chip = within(cardOf('Live session cards')).getByRole('button', { name: /Claude 1/ })
    expect(chip).toHaveAttribute('data-working', 'true')
    // The provider icon is what says *which* kind of session is on the ticket.
    expect(chip.querySelector('svg.claude-glyph')).not.toBeNull()
    act(() => chip.click())
    expect(onFocusSession).toHaveBeenCalledWith(NODE_ID)
  })

  test('a session between turns still shows, but not as working', async () => {
    await renderBoard(wrote(false))

    const chip = within(cardOf('Live session cards')).getByRole('button', { name: /Claude 1/ })
    expect(chip).not.toHaveAttribute('data-working')
  })

  test('a ticket nobody is on shows nothing extra, whatever its status says', async () => {
    await renderBoard(wrote(true))

    expect(within(cardOf('File node')).queryByRole('button', { name: /Claude 1/ })).toBeNull()
    // `in-progress` is not evidence: the chip is only ever on the card a session actually wrote.
    expect(document.querySelectorAll('.ticket-session-chip').length).toBe(1)
  })
})
