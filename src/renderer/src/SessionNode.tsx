import type { NodeProps } from '@xyflow/react'
import ChatNode from './ChatNode'
import type { TerminalCanvasNode } from './canvas-workspace'
import TerminalNode from './TerminalNode'

export default function SessionNode(props: NodeProps<TerminalCanvasNode>): JSX.Element {
  return props.data.kind === 'terminal' ? <TerminalNode {...props} /> : <ChatNode {...props} />
}
