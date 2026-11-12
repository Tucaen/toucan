import { useEffect, useRef, useState } from 'react'
import type { OrchestrationControlRequest, OrchestrationControlState } from '../../shared/ticket-session-spawn'

/**
 * How long an accepted Start now keeps its ticket's button locked when the ticket never leaves
 * `startable` - the orchestrator refused the spawn, or the prompt was lost. A spawn that does
 * happen unlocks it sooner, as the ticket drops out of the list.
 */
const START_REQUEST_LOCK_MS = 120_000

export default function OrchestrationControls({
  request
}: {
  request: OrchestrationControlRequest
}): JSX.Element | null {
  const [state, setState] = useState<OrchestrationControlState | null>(null)
  const [pending, setPending] = useState(false)
  const [chosenTicket, setChosenTicket] = useState<string | undefined>(undefined)
  const [startProblem, setStartProblem] = useState<string | undefined>(undefined)
  // Start now only hands the orchestrator a prompt: the ticket stays startable until its session
  // spawns, so without this a second click would ask for the same ticket again.
  const [requested, setRequested] = useState<ReadonlySet<string>>(new Set())
  const lockTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>())
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

  const release = (ticketId: string): void => {
    clearTimeout(lockTimers.current.get(ticketId))
    lockTimers.current.delete(ticketId)
    setRequested((current) => {
      if (!current.has(ticketId)) return current
      const next = new Set(current)
      next.delete(ticketId)
      return next
    })
  }

  useEffect(() => {
    const timers = lockTimers.current
    return () => {
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
    }
  }, [])

  const startableIds = JSON.stringify((state?.startable ?? []).map((ticket) => ticket.id))
  useEffect(() => {
    // A ticket that left the list has spawned (or settled); a later return must be startable again.
    const still = new Set(JSON.parse(startableIds) as string[])
    for (const ticketId of lockTimers.current.keys()) if (!still.has(ticketId)) release(ticketId)
  }, [startableIds])

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

  const startNow = async (ticketId: string): Promise<void> => {
    setPending(true)
    setStartProblem(undefined)
    try {
      const result = await window.orchestratorApi.forceStartTicket({ provider, conversationId, nodeId, ticketId })
      if (!result.ok) {
        setStartProblem(result.message)
      } else {
        clearTimeout(lockTimers.current.get(ticketId))
        lockTimers.current.set(
          ticketId,
          setTimeout(() => release(ticketId), START_REQUEST_LOCK_MS)
        )
        setRequested((current) => new Set(current).add(ticketId))
        // The selector moves on to the next ticket nobody has asked for yet.
        setChosenTicket(undefined)
      }
    } catch {
      setStartProblem('Toucan could not start the ticket.')
    } finally {
      setPending(false)
    }
  }

  if (!state) return null
  const startable = state.startable ?? []
  // At the spawn checkpoint a forced start would be refused too, so only Continue is offered.
  const startTicket = state.spawnCheckpoint
    ? undefined
    : (startable.find((ticket) => ticket.id === chosenTicket) ??
      startable.find((ticket) => !requested.has(ticket.id)) ??
      startable[0])
  const startRequested = startTicket !== undefined && requested.has(startTicket.id)
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
      {state.status === 'running' && state.spawnCheckpoint && (
        <>
          <span
            className="node-orchestration-checkpoint"
            role="status"
            title="The orchestration used its spawn budget and refuses further spawns until you continue"
          >
            Spawn budget reached ({state.spawnCheckpoint.used}/{state.spawnCheckpoint.budget}) — waiting for you
          </span>
          <button
            type="button"
            className="node-orchestration-continue"
            disabled={pending}
            title="Raise the spawn budget by 20 and wake the orchestrator to retry"
            onClick={() => void apply(window.orchestratorApi.continueSpawns)}
          >
            Continue (+20)
          </button>
        </>
      )}
      {state.status === 'running' && state.pacing && (
        <span className="node-orchestration-pacing" data-state={state.pacing.state} title={state.pacing.reason}>
          Provider pacing: {state.pacing.state} — {state.pacing.reason.replaceAll('_', ' ')}
          {state.pacing.retryAt === undefined ? '' : ` until ${new Date(state.pacing.retryAt).toLocaleString()}`}
        </span>
      )}
      {startTicket && (
        <span className="node-orchestration-start">
          {startable.length > 1 && (
            <select
              aria-label="Ticket to start"
              value={startTicket.id}
              disabled={pending}
              onChange={(event) => setChosenTicket(event.target.value)}
            >
              {startable.map((ticket) => (
                <option key={ticket.id} value={ticket.id}>
                  {ticket.id}: {ticket.title}
                  {requested.has(ticket.id) ? ' (starting…)' : ''}
                </option>
              ))}
            </select>
          )}
          <button
            type="button"
            className="node-orchestration-start-now"
            disabled={pending || startRequested}
            title={
              startRequested
                ? `The orchestrator has been asked to start ticket ${startTicket.id}`
                : `Start ticket ${startTicket.id} now, regardless of the usage limits`
            }
            onClick={() => void startNow(startTicket.id)}
          >
            {startRequested
              ? `Starting ${startTicket.id}…`
              : startable.length > 1
                ? 'Start now'
                : `Start ${startTicket.id} now`}
          </button>
          {startProblem && (
            <span className="node-orchestration-start-problem" role="alert">
              {startProblem}
            </span>
          )}
        </span>
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
