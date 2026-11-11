import { describe, expect, it, vi } from 'vitest'
import type { CanvasNode } from '../src/renderer/src/canvas-workspace'
import { withMultiCloseConfirmation } from '../src/renderer/src/multi-close-confirmation'

const node = (id: string, label: string): CanvasNode => ({ id, data: { label } }) as unknown as CanvasNode
const passThrough = (params: { nodes: CanvasNode[]; edges: never[] }): Promise<typeof params> => Promise.resolve(params)

describe('multi-node close confirmation', () => {
  it('does not ask when a single node is closed', async () => {
    const confirm = vi.fn().mockResolvedValue(false)
    const gate = withMultiCloseConfirmation(passThrough, confirm)
    const nodes = [node('a', 'File')]
    expect(await gate({ nodes, edges: [] })).toEqual({ nodes, edges: [] })
    expect(confirm).not.toHaveBeenCalled()
  })

  it('asks with every label when several nodes would close, and proceeds on confirm', async () => {
    const confirm = vi.fn().mockResolvedValue(true)
    const gate = withMultiCloseConfirmation(passThrough, confirm)
    const nodes = [node('a', 'notes.md'), node('b', 'Chat 1')]
    expect((await gate({ nodes, edges: [] })).nodes).toEqual(nodes)
    expect(confirm).toHaveBeenCalledWith({ labels: ['notes.md', 'Chat 1'] })
  })

  it('closes nothing when the user cancels', async () => {
    const gate = withMultiCloseConfirmation(passThrough, () => Promise.resolve(false))
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
    const gate = withMultiCloseConfirmation(dropFirst, confirm)
    const nodes = [node('a', 'Chat'), node('b', 'File')]
    expect((await gate({ nodes, edges: [] })).nodes).toEqual([nodes[1]])
    expect(confirm).not.toHaveBeenCalled()
  })
})
