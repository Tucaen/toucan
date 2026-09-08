import { Maximize2, Minimize2 } from 'lucide-react'
import { useContext } from 'react'
import { LAYOUT_SHORTCUT_LABELS } from './canvas-layout'
import { NodeFitContext } from './node-fit-context'

export default function NodeFitAction({ nodeId, fitted }: { nodeId: string; fitted: boolean }): JSX.Element {
  const onToggle = useContext(NodeFitContext)
  const label = fitted ? 'Restore' : 'Fit to canvas'
  const shortcut = fitted ? LAYOUT_SHORTCUT_LABELS.restore : LAYOUT_SHORTCUT_LABELS.fit
  const Icon = fitted ? Minimize2 : Maximize2
  return (
    <button
      type="button"
      className="node-fit-action nodrag"
      aria-label={label}
      title={`${label} (${shortcut})`}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation()
        onToggle(nodeId)
      }}
    >
      <Icon aria-hidden="true" />
    </button>
  )
}
