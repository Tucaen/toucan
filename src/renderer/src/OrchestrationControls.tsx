import { useEffect, useState } from 'react'
import type { OrchestrationControlRequest, OrchestrationControlState } from '../../shared/ticket-session-spawn'

export default function OrchestrationControls({
  request
}: {
  request: OrchestrationControlRequest
}): JSX.Element | null {
  const [state, setState] = useState<OrchestrationControlState | null>(null)
  const [pending, setPending] = useState(false)
  const { provider, conversationId, nodeId } = request
  const identity = `${provider}:${conversationId}`

  useEffect(() => {
    let current = true
    const controlRequest = { provider, conversationId, nodeId }
    void window.orchestratorApi
      .orchestrationState(controlRequest)
      .then((next) => {
        if (current) setState(next)
      })
      .catch(() => undefined)
    const unsubscribe = window.orchestratorApi.onOrchestrationState((next) => {
      if (current && `${next.provider}:${next.conversationId}` === identity) setState(next)
    })
    return () => {
      current = false
      unsubscribe()
    }
  }, [conversationId, identity, nodeId, provider])

  const apply = async (
    operation: (value: OrchestrationControlRequest) => Promise<OrchestrationControlState | null>
  ): Promise<void> => {
    setPending(true)
    try {
      setState(await operation({ provider, conversationId, nodeId }))
    } catch {
      // The durable state remains authoritative; a pushed change or remount will retry the read.
    } finally {
      setPending(false)
    }
  }

  if (!state) return null
  if (state.status === 'stopped') return <span className="node-orchestration-stopped">Stopped</span>
  return (
    <span className="node-orchestration-controls nodrag">
      {state.status === 'paused' && (
        <>
          <span className="node-orchestration-paused">
            {state.resetsAt === undefined
              ? 'Paused until usage resets'
              : `Paused until ${new Date(state.resetsAt).toLocaleString()}`}
          </span>
          <button
            type="button"
            className="node-orchestration-resume"
            disabled={pending}
            onClick={() => void apply(window.orchestratorApi.resumeOrchestration)}
          >
            Resume now
          </button>
        </>
      )}
      <button
        type="button"
        className="node-orchestration-stop"
        disabled={pending}
        onClick={() => void apply(window.orchestratorApi.stopOrchestration)}
      >
        Stop orchestration
      </button>
    </span>
  )
}
