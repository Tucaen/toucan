import type { AgentPromptResult } from '../shared/agent'
import type {
  FirstMateActionResult,
  FirstMateLifecycleTask,
  FirstMateTaskDispatch,
  FirstMateValidationDelivery
} from '../shared/firstmate'
import type { FirstMateRuntime } from './firstmate-runtime'
import {
  firstMateAppWakeMessage,
  firstMateReconciliationFailureMessage,
  firstMateReleasedDispatchRecord,
  firstMateRetriedDispatchRecord,
  planValidationDispatch,
  type FirstMateDispatchMemory,
  type FirstMateLifecycleRecord
} from './firstmate-lifecycle'
import { errorMessage } from '../shared/text'

export interface FirstMateLifecycleCoordinator {
  poll(): Promise<void>
  /**
   * Hands a dispatch ADE could not resolve back to reconciliation, on an explicit request from
   * outside. This is the only way an unresolved dispatch is ever sent again, and it reuses the
   * recorded identity so a worker that did receive the first continuation can deduplicate it.
   */
  releaseDispatch(taskId: string): Promise<FirstMateActionResult>
  /**
   * Hands an attempts-exhausted dispatch back to reconciliation with a fresh budget, on an explicit
   * request from outside. Every attempt that exhausted the budget failed before the external send,
   * so a clean attempt reuses the same stable identity and cannot start a second validation run.
   */
  retryDispatch(taskId: string): Promise<FirstMateActionResult>
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

/**
 * `pr-ready` and `blocked` are the only stages a task rests in until an explicit outside action
 * moves it on (a captain reviewing/merging a PR, or an operator releasing/retrying a dispatch) -
 * they never advance on their own the way `dispatching`/`validating` do, and they are the ADE
 * shape of firstmate's own "done or failed" terminal-outcome backstop (see
 * `bin/fm-inactive-reconcile.sh`). Every other stage, including `decision`, is either something
 * firstmate's own watcher already wakes on live from the crew's own status line (and, for
 * `blocked`/`decision`, keeps durably open until an explicit `resolved` line - see
 * `status_open_decisions` in `bin/fm-classify-lib.sh`) or a transient step this same reconcile
 * pass already resolves, so re-announcing it here would only duplicate or pre-empt that signal.
 */
function isTerminalStage(stage: FirstMateLifecycleTask['stage']): boolean {
  return stage === 'pr-ready' || stage === 'blocked'
}

function terminalFingerprint(tasks: FirstMateLifecycleTask[]): string {
  return tasks
    .filter((task) => isTerminalStage(task.stage))
    .map((task) => `${task.id}:${task.stage}:${task.statusHash}:${task.detail}`)
    .join('|')
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

/** One dispatch attempt, addressed the way every reconciliation outcome addresses it. */
interface DispatchAttempt {
  id: string
  attempt: number
}

function claimedTask(task: FirstMateLifecycleTask, { id, attempt }: DispatchAttempt): FirstMateLifecycleTask {
  return {
    ...task,
    stage: 'dispatching',
    detail: `ADE claimed validation dispatch ${id} (attempt ${attempt}).`,
    nextAction: 'await-dispatch',
    dispatch: { id, status: 'claimed', attempt }
  }
}

function acknowledgedTask(
  task: FirstMateLifecycleTask,
  { id, attempt }: DispatchAttempt
): FirstMateLifecycleTask {
  return {
    ...task,
    stage: 'validating',
    detail: 'ADE continued the committed worker directly into no-mistakes validation.',
    nextAction: 'await-validation',
    dispatch: { id, status: 'acknowledged', attempt }
  }
}

function retryableTask(
  task: FirstMateLifecycleTask,
  { id, attempt }: DispatchAttempt,
  message: string
): FirstMateLifecycleTask {
  return {
    ...task,
    stage: 'implemented',
    detail: message,
    nextAction: 'start-validation',
    dispatch: { id, status: 'retryable', attempt, message }
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
    + 'Release the dispatch to resend the same identity, or resolve the task through FirstMate; '
    + 'ADE will not send the continuation again on its own.'
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

    const { dispatchId: id, attempt } = plan
    const dispatch: DispatchAttempt = { id, attempt }
    const settle = async (next: FirstMateLifecycleTask): Promise<FirstMateLifecycleTask> => {
      const settled = await persist(next)
      liveDispatches.delete(id)
      return settled
    }
    const unresolvedBlock = (cause?: string): FirstMateLifecycleTask => blockedTask(
      task,
      { id, status: 'unresolved', attempt },
      unresolvedDetail(id, cause)
    )

    if (plan.action === 'block') {
      return plan.reason === 'unresolved-claim'
        ? settle(unresolvedBlock())
        : settle(blockedTask(
            task,
            { id, status: 'retryable', attempt },
            task.dispatch?.message
              ?? `ADE could not dispatch no-mistakes validation within ${maxDispatchAttempts} attempts.`
          ))
    }

    // Re-persist an outcome this process already observed; the dispatch itself never repeats.
    if (plan.action === 'acknowledge') return settle(acknowledgedTask(task, dispatch))
    if (plan.action === 'retry') {
      const message = task.dispatch?.message ?? 'ADE could not continue no-mistakes validation.'
      return settle(retryableTask(task, dispatch, message))
    }

    // The intent to dispatch becomes durable before the external continuation runs, so a crash
    // in the gap reloads as a claim to recover rather than as work still to be sent.
    const claimed = await persist(claimedTask(task, dispatch))
    liveDispatches.set(id, 'claimed')

    let delivery: FirstMateValidationDelivery
    try {
      delivery = await options.runtime.continueValidation(task.id, id)
    } catch (error) {
      // A continuation that threw may still have been delivered, so its outcome is unknowable.
      delivery = { outcome: 'indeterminate', message: errorMessage(error) }
    }

    if (delivery.outcome === 'acknowledged') {
      liveDispatches.set(id, 'acknowledged')
      return settle(acknowledgedTask(claimed, dispatch))
    }

    // Proven to have failed before anything reached FirstMate: this attempt is safe to retire, and
    // whether the budget allows another is the next pass's decision, from durable state alone.
    if (delivery.outcome === 'rejected-before-send') {
      liveDispatches.set(id, 'retryable')
      return settle(retryableTask(claimed, dispatch, delivery.message))
    }

    // Indeterminate: a timeout, a failure after the send began, or a lost acknowledgement. The
    // continuation may already be running, so ADE never re-sends it on its own; recovery is explicit.
    // Clearing the claim first means a failed write recovers to the same conclusion.
    liveDispatches.delete(id)
    return persist(blockedTask(
      claimed,
      { id, status: 'unresolved', attempt },
      unresolvedDetail(id, delivery.message)
    ))
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

      const nextFingerprint = terminalFingerprint(changed)
      if (nextFingerprint === '') {
        // No task is currently resting in a terminal stage: clear what was delivered so a later
        // terminal reach - even one that happens to look identical to an earlier one - wakes again
        // instead of being masked by a stale comparison against a state that no longer holds.
        deliveredFingerprint = ''
      } else if (nextFingerprint !== deliveredFingerprint) {
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

  /**
   * The shared shape of every explicit dispatch recovery: find the durable task, ask a record
   * builder whether the recovery applies to its current state, and persist the record it returns.
   * The builder is the only difference between releasing an unresolved dispatch and retrying an
   * exhausted one, so each recovery is just the builder plus the reason it does not apply.
   */
  const recoverDispatch = async (
    taskId: string,
    build: (task: FirstMateLifecycleTask, now: Date) => FirstMateLifecycleRecord | undefined,
    inapplicable: string
  ): Promise<FirstMateActionResult> => {
    try {
      const lifecycle = await options.runtime.lifecycle()
      const task = lifecycle.tasks.find((candidate) => candidate.id === taskId)
      if (!task) return { ok: false, message: `ADE has no durable state for task ${taskId}.` }
      const record = build(task, now())
      if (!record) return { ok: false, message: inapplicable }
      await options.runtime.recordLifecycle(taskId, record)
      return { ok: true }
    } catch (error) {
      return { ok: false, message: errorMessage(error) }
    }
  }

  return {
    poll,
    releaseDispatch: (taskId: string): Promise<FirstMateActionResult> => recoverDispatch(
      taskId,
      firstMateReleasedDispatchRecord,
      `Task ${taskId} has no unresolved validation dispatch to release.`
    ),
    retryDispatch: (taskId: string): Promise<FirstMateActionResult> => recoverDispatch(
      taskId,
      firstMateRetriedDispatchRecord,
      `Task ${taskId} has no exhausted validation dispatch to retry.`
    ),
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
