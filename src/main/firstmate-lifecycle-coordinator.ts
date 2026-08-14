import type { AgentPromptResult } from '../shared/agent'
import type {
  FirstMateActionResult,
  FirstMateLifecycleTask,
  FirstMateTaskDispatch
} from '../shared/firstmate'
import type { FirstMateRuntime } from './firstmate-runtime'
import {
  firstMateAppWakeMessage,
  firstMateReconciliationFailureMessage,
  planValidationDispatch,
  type FirstMateDispatchMemory,
  type FirstMateLifecycleRecord
} from './firstmate-lifecycle'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export interface FirstMateLifecycleCoordinator {
  poll(): Promise<void>
  start(): void
  stop(): void
}

export interface FirstMateLifecycleCoordinatorOptions {
  runtime: Pick<FirstMateRuntime, 'lifecycle' | 'continueValidation' | 'recordLifecycle'>
  wakeCaptain(message: string): Promise<AgentPromptResult>
  intervalMs?: number
  /** Validation dispatch attempts allowed per implementation before the task is blocked. */
  maxDispatchAttempts?: number
  now?(): Date
}

function fingerprint(tasks: FirstMateLifecycleTask[]): string {
  return tasks.map((task) => `${task.id}:${task.stage}:${task.statusHash}:${task.detail}`).join('|')
}

function recordFor(task: FirstMateLifecycleTask, now: Date): FirstMateLifecycleRecord {
  return {
    stage: task.stage,
    detail: task.detail,
    statusHash: task.statusHash,
    ...(task.nextAction ? { nextAction: task.nextAction } : {}),
    ...(task.dispatch ? { dispatch: task.dispatch } : {}),
    ...(task.prUrl ? { prUrl: task.prUrl } : {}),
    updatedAt: now.toISOString()
  }
}

function claimedTask(
  task: FirstMateLifecycleTask,
  dispatch: FirstMateTaskDispatch
): FirstMateLifecycleTask {
  return {
    ...task,
    stage: 'dispatching',
    detail: `ADE claimed validation dispatch ${dispatch.id} (attempt ${dispatch.attempt}).`,
    nextAction: 'await-dispatch',
    dispatch
  }
}

function acknowledgedTask(
  task: FirstMateLifecycleTask,
  dispatch: FirstMateTaskDispatch
): FirstMateLifecycleTask {
  return {
    ...task,
    stage: 'validating',
    detail: 'ADE continued the committed worker directly into no-mistakes validation.',
    nextAction: 'await-validation',
    dispatch: { ...dispatch, status: 'acknowledged' }
  }
}

function releasedTask(
  task: FirstMateLifecycleTask,
  dispatch: FirstMateTaskDispatch,
  message: string
): FirstMateLifecycleTask {
  return {
    ...task,
    stage: 'implemented',
    detail: message,
    nextAction: 'start-validation',
    dispatch: { ...dispatch, status: 'retryable', message }
  }
}

function blockedTask(
  task: FirstMateLifecycleTask,
  dispatch: FirstMateTaskDispatch,
  detail: string
): FirstMateLifecycleTask {
  return {
    ...task,
    stage: 'blocked',
    detail,
    nextAction: 'await-help',
    dispatch: { ...dispatch, message: detail }
  }
}

function unresolvedDetail(dispatchId: string, cause?: string): string {
  return `ADE claimed validation dispatch ${dispatchId} but cannot establish whether it reached FirstMate`
    + `${cause ? ` (${cause})` : ''}. `
    + 'Recover this task explicitly; ADE will not send the continuation a second time.'
}

function unresolved(dispatchId: string, attempt: number): FirstMateTaskDispatch {
  return { id: dispatchId, status: 'unresolved', attempt }
}

function claim(dispatchId: string, attempt: number): FirstMateTaskDispatch {
  return { id: dispatchId, status: 'claimed', attempt }
}

export function createFirstMateLifecycleCoordinator(
  options: FirstMateLifecycleCoordinatorOptions
): FirstMateLifecycleCoordinator {
  const intervalMs = options.intervalMs ?? 2_500
  const maxDispatchAttempts = Math.max(1, options.maxDispatchAttempts ?? 3)
  const now = options.now ?? (() => new Date())
  let timer: ReturnType<typeof setInterval> | undefined
  let polling = false
  let deliveredFingerprint = ''
  /**
   * Outcomes this process observed for the claims it wrote. It deliberately does not survive a
   * restart: a claim ADE cannot account for must be recovered explicitly, never re-dispatched.
   */
  const liveDispatches = new Map<string, FirstMateDispatchMemory>()

  const persist = async (task: FirstMateLifecycleTask): Promise<FirstMateLifecycleTask> => {
    await options.runtime.recordLifecycle(task.id, recordFor(task, now()))
    return task
  }

  const reconcileTask = async (task: FirstMateLifecycleTask): Promise<FirstMateLifecycleTask> => {
    const plan = planValidationDispatch({ task, liveDispatches, maxAttempts: maxDispatchAttempts })
    if (plan.action === 'none') return task

    const { dispatchId, attempt } = plan
    const settle = async (next: FirstMateLifecycleTask): Promise<FirstMateLifecycleTask> => {
      const settled = await persist(next)
      liveDispatches.delete(dispatchId)
      return settled
    }

    if (plan.action === 'block') {
      return plan.reason === 'unresolved-claim'
        ? settle(blockedTask(task, unresolved(dispatchId, attempt), unresolvedDetail(dispatchId)))
        : settle(blockedTask(
            task,
            { id: dispatchId, status: 'retryable', attempt },
            task.dispatch?.message
              ?? `ADE could not dispatch no-mistakes validation within ${maxDispatchAttempts} attempts.`
          ))
    }

    // Re-persist an outcome this process already observed; the dispatch itself never repeats.
    if (plan.action === 'acknowledge') {
      return settle(acknowledgedTask(task, claim(dispatchId, attempt)))
    }
    if (plan.action === 'release') {
      const message = task.dispatch?.message ?? 'ADE could not continue no-mistakes validation.'
      return settle(releasedTask(task, claim(dispatchId, attempt), message))
    }

    // The intent to dispatch becomes durable before the external continuation runs, so a crash
    // in the gap reloads as a claim to recover rather than as work still to be sent.
    const claimed = await persist(claimedTask(task, claim(dispatchId, attempt)))
    liveDispatches.set(dispatchId, 'claimed')

    let result: FirstMateActionResult
    try {
      result = await options.runtime.continueValidation(task.id, dispatchId)
    } catch (error) {
      // A continuation that threw may still have been delivered, so its outcome is unknowable.
      // Clearing the claim first means a failed write recovers to the same conclusion.
      liveDispatches.delete(dispatchId)
      return persist(blockedTask(
        claimed,
        unresolved(dispatchId, attempt),
        unresolvedDetail(dispatchId, errorMessage(error))
      ))
    }

    if (result.ok) {
      liveDispatches.set(dispatchId, 'acknowledged')
      return settle(acknowledgedTask(claimed, claim(dispatchId, attempt)))
    }

    // A rejected continuation is proof nothing was delivered, so this attempt is safe to retire.
    const message = result.message ?? 'ADE could not continue no-mistakes validation.'
    liveDispatches.set(dispatchId, 'released')
    return settle(plan.final
      ? blockedTask(claimed, { id: dispatchId, status: 'retryable', attempt }, message)
      : releasedTask(claimed, claim(dispatchId, attempt), message))
  }

  const poll = async (): Promise<void> => {
    if (polling) return
    polling = true
    try {
      const lifecycle = await options.runtime.lifecycle()
      const changed = [...lifecycle.tasks]
      for (let index = 0; index < changed.length; index += 1) {
        changed[index] = await reconcileTask(changed[index])
      }

      const nextFingerprint = fingerprint(changed)
      if (changed.length > 0 && nextFingerprint !== deliveredFingerprint) {
        const result = await options.wakeCaptain(firstMateAppWakeMessage(changed))
        if (result.ok) deliveredFingerprint = nextFingerprint
      }
    } catch (error) {
      try {
        await options.wakeCaptain(firstMateReconciliationFailureMessage(errorMessage(error)))
      } catch {
        // Polling retries from the journal even when the captain session is not ready yet.
      }
    } finally {
      polling = false
    }
  }

  return {
    poll,
    start(): void {
      if (timer) return
      void poll()
      timer = setInterval(() => { void poll() }, intervalMs)
    },
    stop(): void {
      if (timer) clearInterval(timer)
      timer = undefined
    }
  }
}
