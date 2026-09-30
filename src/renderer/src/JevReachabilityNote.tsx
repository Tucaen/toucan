import { useEffect, useState } from 'react'
import { isJevReachability, type JevReachability } from '../../shared/orchestration-routing'

/**
 * Whether Jev can route this orchestrator's tickets, shown in its header before the task is sent
 * (#36): an orchestrator whose Jev is unavailable still runs, but routes every ticket itself, and
 * the human should know that before launching it. Asked once per mount; main answers with the
 * service's reachability and never the key.
 */
export default function JevReachabilityNote(): JSX.Element | null {
  const [reachability, setReachability] = useState<JevReachability>()
  useEffect(() => {
    let current = true
    window.orchestratorApi
      .jevReachability()
      .then((answer) => {
        if (current && isJevReachability(answer)) setReachability(answer)
      })
      .catch(() => {
        if (current) setReachability({ state: 'unreachable', reason: 'Toucan could not check' })
      })
    return () => {
      current = false
    }
  }, [])
  if (!reachability) return null
  const [label, title] =
    reachability.state === 'reachable'
      ? [
          'Jev reachable',
          'TypeSafe answers and TYPESAFE_API_KEY is set; the key itself is first checked when the orchestrator routes. Jev judges each ticket’s difficulty tier, your tier mapping picks the model.'
        ]
      : reachability.state === 'no-key'
        ? [
            'Jev unavailable',
            'TYPESAFE_API_KEY is not set for Toucan, so the orchestrator will judge each tier itself. Launch Toucan with the key to route through Jev.'
          ]
        : [
            'Jev unreachable',
            `TypeSafe did not answer (${reachability.reason}), so the orchestrator may have to judge each tier itself.`
          ]
  return (
    <span className="node-jev-reachability" data-state={reachability.state} title={title}>
      {label}
    </span>
  )
}
