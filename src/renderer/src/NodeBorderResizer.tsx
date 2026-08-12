import { NodeResizer } from '@xyflow/react'

interface NodeBorderResizerProps {
  color: string
  minHeight: number
  minWidth: number
  selected: boolean
}

export default function NodeBorderResizer({
  color,
  minHeight,
  minWidth,
  selected
}: NodeBorderResizerProps): JSX.Element {
  return (
    <NodeResizer
      minWidth={minWidth}
      minHeight={minHeight}
      color={selected ? color : 'transparent'}
      lineClassName="node-resize-line"
      handleClassName="node-resize-handle"
    />
  )
}
