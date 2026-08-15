import type { AgentProvider } from './agent'
import type { FirstMateDeliveryMode } from './firstmate'

export const FIRSTMATE_TASK_CONTEXT_META_KEY = 'ade_task_context'

export interface FirstMateTaskContext {
  version: 1
  project: {
    adeProjectId: string
    registryName: string
    windowsPath: string
    wslPath: string
    mode: FirstMateDeliveryMode
    autonomy: boolean
  }
  validator: {
    agent: AgentProvider
    model: string
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? value as Record<string, unknown> : undefined
}

function nonEmptyText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !/[\u0000-\u001f\u007f]/.test(value)
}

const DELIVERY_MODES: ReadonlySet<FirstMateDeliveryMode> = new Set([
  'no-mistakes',
  'no-mistakes-prod-only',
  'direct-PR',
  'local-only'
])

function parsedContext(value: unknown): FirstMateTaskContext | undefined {
  const candidate = asRecord(value)
  const project = asRecord(candidate?.project)
  const validator = asRecord(candidate?.validator)
  if (
    candidate?.version !== 1
    || !nonEmptyText(project?.adeProjectId)
    || !nonEmptyText(project.registryName)
    || !nonEmptyText(project.windowsPath)
    || !/^[a-zA-Z]:\\/.test(project.windowsPath)
    || !nonEmptyText(project.wslPath)
    || !/^\/mnt\/[a-z](?:\/|$)/.test(project.wslPath)
    || !DELIVERY_MODES.has(project.mode as FirstMateDeliveryMode)
    || typeof project.autonomy !== 'boolean'
    || (validator?.agent !== 'codex' && validator?.agent !== 'claude')
    || !nonEmptyText(validator.model)
    || !/^[a-zA-Z0-9._:+\/-]+$/.test(validator.model)
  ) return undefined

  return {
    version: 1,
    project: {
      adeProjectId: project.adeProjectId,
      registryName: project.registryName,
      windowsPath: project.windowsPath,
      wslPath: project.wslPath,
      mode: project.mode as FirstMateDeliveryMode,
      autonomy: project.autonomy
    },
    validator: { agent: validator.agent, model: validator.model }
  }
}

/** One shell-safe, single-line carrier that FirstMate copies into state/<id>.meta. */
export function firstMateTaskContextMetadata(context: FirstMateTaskContext): string {
  return `${FIRSTMATE_TASK_CONTEXT_META_KEY}=${encodeURIComponent(JSON.stringify(context))}`
}

/** Reads exactly one carrier. Duplicates are ambiguous and therefore rejected. */
export function firstMateTaskContextFromMetadata(metadata: string): FirstMateTaskContext | undefined {
  const prefix = `${FIRSTMATE_TASK_CONTEXT_META_KEY}=`
  const carriers = metadata.split(/\r?\n/).filter((line) => line.startsWith(prefix))
  if (carriers.length !== 1) return undefined
  try {
    return parsedContext(JSON.parse(decodeURIComponent(carriers[0]!.slice(prefix.length))))
  } catch {
    return undefined
  }
}
