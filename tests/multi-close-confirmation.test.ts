import { describe, expect, it, vi } from 'vitest'
import type { CanvasNode } from '../src/renderer/src/canvas-workspace'
import { orphanedWorktrees, withMultiCloseConfirmation } from '../src/renderer/src/multi-close-confirmation'

const node = (id: string, label: string): CanvasNode => ({ id, data: { label } }) as unknown as CanvasNode
const noCanvas = (): CanvasNode[] => []
const chat = (id: string, data: Record<string, unknown>): CanvasNode =>
  ({ id, type: 'terminalNode', data: { label: id, kind: 'claude', ...data } }) as unknown as CanvasNode
const worktree = (id: string, branch: string): CanvasNode =>
  ({ id: `node-${id}`, type: 'worktreeNode', data: { label: branch, worktreeId: id, branch } }) as unknown as CanvasNode
const passThrough = (params: { nodes: CanvasNode[]; edges: never[] }): Promise<typeof params> => Promise.resolve(params)

describe('multi-node close confirmation', () => {
  it('does not ask when a single node is closed', async () => {
    const confirm = vi.fn().mockResolvedValue(false)
    const gate = withMultiCloseConfirmation(passThrough, confirm, noCanvas)
    const nodes = [node('a', 'File')]
    expect(await gate({ nodes, edges: [] })).toEqual({ nodes, edges: [] })
    expect(confirm).not.toHaveBeenCalled()
  })

  it('asks with every label when several nodes would close, and proceeds on confirm', async () => {
    const confirm = vi.fn().mockResolvedValue(true)
    const gate = withMultiCloseConfirmation(passThrough, confirm, noCanvas)
    const nodes = [node('a', 'notes.md'), node('b', 'Chat 1')]
    expect((await gate({ nodes, edges: [] })).nodes).toEqual(nodes)
    expect(confirm).toHaveBeenCalledWith({ labels: ['notes.md', 'Chat 1'], orphanedWorktrees: [] })
  })

  it('closes nothing when the user cancels', async () => {
    const gate = withMultiCloseConfirmation(passThrough, () => Promise.resolve(false), noCanvas)
    expect(await gate({ nodes: [node('a', 'A'), node('b', 'B')], edges: [] })).toEqual({ nodes: [], edges: [] })
  })

  it('counts what survives the earlier stage, not what was selected', async () => {
    const confirm = vi.fn().mockResolvedValue(false)
    const dropFirst = ({
      nodes,
      edges
    }: {
      nodes: CanvasNode[]
      edges: never[]
    }): Promise<{ nodes: CanvasNode[]; edges: never[] }> => Promise.resolve({ nodes: nodes.slice(1), edges })
    const gate = withMultiCloseConfirmation(dropFirst, confirm, noCanvas)
    const nodes = [node('a', 'Chat'), node('b', 'File')]
    expect((await gate({ nodes, edges: [] })).nodes).toEqual([nodes[1]])
    expect(confirm).not.toHaveBeenCalled()
  })

  describe('closing an orchestrator', () => {
    const orchestrator = chat('orch', { role: 'orchestrator' })
    const link = { nodeId: 'orch', conversationId: 'c1' }
    const canvas = [
      orchestrator,
      worktree('w1', 'ticket/34'),
      worktree('w2', 'ticket/35'),
      worktree('w3', 'feature/other'),
      chat('t34', { worktreeId: 'w1', orchestratedBy: link }),
      chat('t35', { worktreeId: 'w2', orchestratedBy: link }),
      chat('mine', { worktreeId: 'w3' }),
      chat('foreign', { worktreeId: 'w3', orchestratedBy: { nodeId: 'other', conversationId: 'c2' } })
    ]

    it('asks with the worktrees its ticket sessions would leave behind, even for one node', async () => {
      const confirm = vi.fn().mockResolvedValue(false)
      const gate = withMultiCloseConfirmation(passThrough, confirm, () => canvas)
      expect(await gate({ nodes: [orchestrator], edges: [] })).toEqual({ nodes: [], edges: [] })
      expect(confirm).toHaveBeenCalledWith({ labels: ['orch'], orphanedWorktrees: ['ticket/34', 'ticket/35'] })
    })

    it('does not ask when no worktree holds one of its ticket sessions', async () => {
      const confirm = vi.fn()
      const gate = withMultiCloseConfirmation(passThrough, confirm, () => [orchestrator, worktree('w3', 'x')])
      expect((await gate({ nodes: [orchestrator], edges: [] })).nodes).toEqual([orchestrator])
      expect(confirm).not.toHaveBeenCalled()
    })

    it('does not treat an ordinary chat as an orchestrator', async () => {
      const confirm = vi.fn()
      const gate = withMultiCloseConfirmation(passThrough, confirm, () => canvas)
      const plain = chat('orch', {})
      expect((await gate({ nodes: [plain], edges: [] })).nodes).toEqual([plain])
      expect(confirm).not.toHaveBeenCalled()
    })

    it('leaves out a worktree the same action closes', () => {
      expect(orphanedWorktrees([orchestrator, canvas[1]!], canvas)).toEqual(['ticket/35'])
    })
  })
})
