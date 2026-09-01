import { NodeResizeControl, ResizeControlVariant, type ControlLinePosition, type ControlPosition } from '@xyflow/react'

/**
 * xyflow anchors its resize controls on the node's *outer* border (`left`/`top: 100%`), but every
 * node root clips its overflow to keep the rounded corners - which erased the right edge, the
 * bottom edge and three of the four corner handles. So each control is placed explicitly, just
 * inside the border, and its grab band (see `.node-resize-line` / `.node-resize-handle` in
 * styles.css) only ever grows inward, where nothing can clip it.
 *
 * The offsets are inline rather than in the stylesheet on purpose: xyflow's own positioning rules
 * are class-chained and would otherwise win the specificity contest.
 */
const LINE_OFFSETS: Record<ControlLinePosition, React.CSSProperties> = {
  top: { top: 0, transform: 'none' },
  bottom: { top: 'auto', bottom: 0, transform: 'none' },
  left: { left: 0, transform: 'none' },
  right: { left: 'auto', right: 0, transform: 'none' }
}

const HANDLE_OFFSETS: Record<string, React.CSSProperties> = {
  'top-left': { top: 0, left: 0, translate: 'none' },
  'top-right': { top: 0, left: 'auto', right: 0, translate: 'none' },
  'bottom-left': { top: 'auto', bottom: 0, left: 0, translate: 'none' },
  'bottom-right': { top: 'auto', bottom: 0, left: 'auto', right: 0, translate: 'none' }
}

const LINE_POSITIONS = Object.keys(LINE_OFFSETS) as ControlLinePosition[]
const HANDLE_POSITIONS = Object.keys(HANDLE_OFFSETS) as ControlPosition[]

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
    <>
      {LINE_POSITIONS.map((position) => (
        <NodeResizeControl
          key={position}
          position={position}
          variant={ResizeControlVariant.Line}
          className="node-resize-line"
          style={LINE_OFFSETS[position]}
          color={selected ? color : 'transparent'}
          minWidth={minWidth}
          minHeight={minHeight}
        />
      ))}
      {HANDLE_POSITIONS.map((position) => (
        <NodeResizeControl
          key={position}
          position={position}
          variant={ResizeControlVariant.Handle}
          className="node-resize-handle"
          // The handles carry xyflow's white outline, which would otherwise stay visible on every
          // unselected node now that no corner is clipped away.
          style={{ ...HANDLE_OFFSETS[position], borderColor: selected ? '#fff' : 'transparent' }}
          color={selected ? color : 'transparent'}
          minWidth={minWidth}
          minHeight={minHeight}
        />
      ))}
    </>
  )
}
