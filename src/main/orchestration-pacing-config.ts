import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { DEFAULT_ORCHESTRATION_PACING_POLICY, type OrchestrationPacingPolicy } from '../shared/orchestration-pacing'
import { isRecord } from '../shared/record'
import { errorMessage } from '../shared/text'
import { writeNewFileDurably } from './durable-file'

/**
 * Global policy for the provider-wide spawn gate. This deliberately has no project override: two
 * projects sharing a provider must not evaluate different policies while contending for one gate.
 */
export interface OrchestrationPacingConfig extends OrchestrationPacingPolicy {
  enabled: boolean
}

/** @internal exported for tests */
export const DEFAULT_ORCHESTRATION_PACING_CONFIG: OrchestrationPacingConfig = {
  enabled: false,
  fiveHour: { ...DEFAULT_ORCHESTRATION_PACING_POLICY.fiveHour },
  unavailableUsage: { ...DEFAULT_ORCHESTRATION_PACING_POLICY.unavailableUsage }
}

type ParseResult = { config: OrchestrationPacingConfig; error?: undefined } | { config?: undefined; error: string }

const percentage = (value: unknown, field: string): string | undefined =>
  typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100
    ? `${field} must be a finite percentage from 0 through 100`
    : undefined

/**
 * Strictly validates the hand-editable global pacing configuration.
 * @internal exported for tests
 */
export function parseOrchestrationPacingConfig(value: unknown): ParseResult {
  if (!isRecord(value)) return { error: 'the orchestration pacing configuration must be a JSON object' }
  for (const field of Object.keys(value)) {
    if (field !== 'enabled' && field !== 'fiveHour' && field !== 'unavailableUsage') {
      return { error: `unknown field "${field}" in the orchestration pacing configuration` }
    }
  }
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') {
    return { error: 'enabled must be a boolean' }
  }

  const fiveHour = { ...DEFAULT_ORCHESTRATION_PACING_CONFIG.fiveHour }
  if (value.fiveHour !== undefined) {
    if (!isRecord(value.fiveHour)) return { error: 'fiveHour must be an object' }
    for (const field of Object.keys(value.fiveHour)) {
      if (field !== 'drainAtPercent' && field !== 'pauseAtPercent') {
        return { error: `unknown field "${field}" in fiveHour` }
      }
    }
    const drainError =
      value.fiveHour.drainAtPercent === undefined
        ? undefined
        : percentage(value.fiveHour.drainAtPercent, 'fiveHour.drainAtPercent')
    if (drainError) return { error: drainError }
    const pauseError =
      value.fiveHour.pauseAtPercent === undefined
        ? undefined
        : percentage(value.fiveHour.pauseAtPercent, 'fiveHour.pauseAtPercent')
    if (pauseError) return { error: pauseError }
    if (typeof value.fiveHour.drainAtPercent === 'number') fiveHour.drainAtPercent = value.fiveHour.drainAtPercent
    if (typeof value.fiveHour.pauseAtPercent === 'number') fiveHour.pauseAtPercent = value.fiveHour.pauseAtPercent
  }
  if (fiveHour.drainAtPercent > fiveHour.pauseAtPercent) {
    return { error: 'fiveHour.drainAtPercent must not exceed fiveHour.pauseAtPercent' }
  }

  const unavailableUsage = { ...DEFAULT_ORCHESTRATION_PACING_CONFIG.unavailableUsage }
  if (value.unavailableUsage !== undefined) {
    if (!isRecord(value.unavailableUsage)) return { error: 'unavailableUsage must be an object' }
    for (const field of Object.keys(value.unavailableUsage)) {
      if (field !== 'maxActiveTicketSessions') {
        return { error: `unknown field "${field}" in unavailableUsage` }
      }
    }
    const reserve = value.unavailableUsage.maxActiveTicketSessions
    if (reserve !== undefined) {
      if (typeof reserve !== 'number' || !Number.isInteger(reserve) || reserve < 0) {
        return { error: 'unavailableUsage.maxActiveTicketSessions must be a non-negative integer' }
      }
      unavailableUsage.maxActiveTicketSessions = reserve
    }
  }

  return {
    config: {
      enabled: value.enabled ?? DEFAULT_ORCHESTRATION_PACING_CONFIG.enabled,
      fiveHour,
      unavailableUsage
    }
  }
}

export type OrchestrationPacingConfigLoad = ParseResult & { path: string }

const FILE = 'orchestration-pacing.json'

/** Reads the process-global pacing policy once at startup; edits apply after Toucan restarts. */
export async function loadOrchestrationPacingConfig(options: {
  userDataPath: string
}): Promise<OrchestrationPacingConfigLoad> {
  const path = join(options.userDataPath, FILE)
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      return { path, error: `the orchestration pacing configuration ${path} could not be read: ${errorMessage(error)}` }
    }
    try {
      await mkdir(dirname(path), { recursive: true })
      await writeNewFileDurably(path, `${JSON.stringify(DEFAULT_ORCHESTRATION_PACING_CONFIG, null, 2)}\n`)
    } catch {
      // Defaults remain usable; writing the discoverable copy is a convenience, not admission.
    }
    return { path, config: DEFAULT_ORCHESTRATION_PACING_CONFIG }
  }

  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    return { path, error: `the orchestration pacing configuration ${path} is not valid JSON: ${errorMessage(error)}` }
  }
  const parsed = parseOrchestrationPacingConfig(value)
  return parsed.error !== undefined
    ? { path, error: `the orchestration pacing configuration ${path} is invalid: ${parsed.error}` }
    : { path, config: parsed.config }
}
