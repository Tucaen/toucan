import type { AgentPromptResult } from '../shared/agent'
import type { FirstMateLifecycleTask } from '../shared/firstmate'
import type { FirstMateRuntime } from './firstmate-runtime'
import { firstMateAppWakeMessage, type FirstMateLifecycleRecord } from './firstmate-lifecycle'

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
  now?(): Date
}

function fingerprint(tasks: FirstMateLifecycleTask[]): string {
  return tasks.map((task) => `${task.id}:${task.stage}:${task.statusHash}:${task.detail}`).join('|')
}

function recordFor(
  task: FirstMateLifecycleTask,
  stage: FirstMateLifecycleRecord['stage'],
  detail: string,
  nextAction: FirstMateLifecycleRecord['nextAction'],
  now: Date
): FirstMateLifecycleRecord {
  return {
    stage,
    detail,
    statusHash: task.statusHash,
    ...(nextAction ? { nextAction } : {}),
    updatedAt: now.toISOString()
  }
}

export function createFirstMateLifecycleCoordinator(
  options: FirstMateLifecycleCoordinatorOptions
): FirstMateLifecycleCoordinator {
  const intervalMs = options.intervalMs ?? 2_500
  const now = options.now ?? (() => new Date())
  let timer: ReturnType<typeof setInterval> | undefined
  let polling = false
  let deliveredFingerprint = ''

  const poll = async (): Promise<void> => {
    if (polling) return
    polling = true
    try {
      const lifecycle = await options.runtime.lifecycle()
      const changed = [...lifecycle.tasks]
      for (let index = 0; index < changed.length; index += 1) {
        const task = changed[index]
        if (task.stage !== 'implemented' || task.nextAction !== 'start-validation') continue

        await options.runtime.recordLifecycle(
          task.id,
          recordFor(task, 'implemented', task.detail, 'start-validation', now())
        )
        const result = await options.runtime.continueValidation(task.id)
        const next = result.ok
          ? {
              ...task,
              stage: 'validating' as const,
              detail: 'ADE continued the committed worker directly into no-mistakes validation.',
              nextAction: 'await-validation' as const
            }
          : {
              ...task,
              stage: 'blocked' as const,
              detail: result.message ?? 'ADE could not continue no-mistakes validation.',
              nextAction: 'await-help' as const
            }
        await options.runtime.recordLifecycle(
          task.id,
          recordFor(next, next.stage, next.detail, next.nextAction, now())
        )
        changed[index] = next
      }

      const nextFingerprint = fingerprint(changed)
      if (changed.length > 0 && nextFingerprint !== deliveredFingerprint) {
        const result = await options.wakeCaptain(firstMateAppWakeMessage(changed))
        if (result.ok) deliveredFingerprint = nextFingerprint
      }
    } catch (error) {
      try {
        await options.wakeCaptain(
          `\u2063FIRSTMATE_OP: v1 ade-app-wake: Lifecycle reconciliation failed: ${errorMessage(error)}. `
          + 'ADE will retry from durable task state; use the existing authority boundary if intervention is required.'
        )
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
