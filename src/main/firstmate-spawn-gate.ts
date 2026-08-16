import type { AgentProvider } from '../shared/agent'
import type { FirstMateDeliveryMode, FirstMateExternalProject } from '../shared/firstmate'
import type { FirstMateTaskContext } from '../shared/firstmate-task-context'

/**
 * The subset of a registered external project the spawn gate checks against. Every field here is
 * authoritative: a context that disagrees with any of them was built from a stale or tampered catalog
 * and must not reach a worker.
 */
export type FirstMateSpawnGateProject = Pick<FirstMateExternalProject,
  'adeProjectId' | 'registryName' | 'windowsPath' | 'wslPath' | 'mode' | 'autonomy'
>

export interface FirstMateSpawnGateValidator {
  agent: AgentProvider
  model: string
}

/**
 * Validates a durable ADE task context against the authoritative project record and current
 * validator before a worker launches. Returns an error naming the disagreeing value and the
 * authoritative record, or `undefined` when the context is valid.
 *
 * This gate checks everything ADE controls: stable project identity, canonical checkout paths,
 * delivery posture, autonomy authorization, provider, and model. Worktree isolation is enforced
 * by `fm-spawn.sh`'s mandatory Git guard and not duplicated here.
 */
export function firstMateSpawnContextProblem(
  context: FirstMateTaskContext,
  project: FirstMateSpawnGateProject,
  validator: FirstMateSpawnGateValidator
): string | undefined {
  const pinned = context.project
  if (pinned.adeProjectId !== project.adeProjectId) {
    return `Project id ${JSON.stringify(pinned.adeProjectId)} disagrees with`
      + ` authoritative record ${JSON.stringify(project.adeProjectId)}.`
  }
  if (pinned.registryName !== project.registryName) {
    return `Registry name ${JSON.stringify(pinned.registryName)} disagrees with`
      + ` authoritative record ${JSON.stringify(project.registryName)}.`
  }
  if (pinned.windowsPath !== project.windowsPath) {
    return `Canonical Windows path ${JSON.stringify(pinned.windowsPath)} disagrees with`
      + ` authoritative record ${JSON.stringify(project.windowsPath)}.`
  }
  if (pinned.wslPath !== project.wslPath) {
    return `Canonical WSL path ${JSON.stringify(pinned.wslPath)} disagrees with`
      + ` authoritative record ${JSON.stringify(project.wslPath)}.`
  }
  if (pinned.mode !== project.mode) {
    return `Delivery posture ${JSON.stringify(pinned.mode)} disagrees with`
      + ` authoritative record ${JSON.stringify(project.mode)}.`
  }
  if (pinned.autonomy !== project.autonomy) {
    return `Autonomy authorization ${JSON.stringify(pinned.autonomy)} disagrees with`
      + ` authoritative record ${JSON.stringify(project.autonomy)}.`
  }
  if (context.validator.agent !== validator.agent) {
    return `Provider ${JSON.stringify(context.validator.agent)} disagrees with`
      + ` authoritative record ${JSON.stringify(validator.agent)}.`
  }
  if (context.validator.model !== validator.model) {
    return `Model ${JSON.stringify(context.validator.model)} disagrees with`
      + ` authoritative record ${JSON.stringify(validator.model)}.`
  }
  return undefined
}
