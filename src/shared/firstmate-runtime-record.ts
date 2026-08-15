import type { AgentProvider } from './agent'
import type { FirstMateTaskContext } from './firstmate-task-context'

/**
 * The single authoritative definition of ADE's `ade-runtime.json` document: the structured record
 * ADE writes into FirstMate's private home to pin the host contract and the task-scoped validator.
 * Every producer serializes through {@link serializeFirstMateRuntimeRecord} and every consumer reads
 * through {@link parseFirstMateRuntimeRecord}, so the schema lives here and nowhere else. Inline WSL
 * programs never rebuild this object; they receive an already-serialized record and write its bytes.
 */
export const FIRSTMATE_RUNTIME_RECORD_VERSION = 1

/** The host half of the contract: ADE, not a terminal, supervises the captain app-natively. */
export interface FirstMateRuntimeHost {
  kind: 'ade-app'
  supervisor: 'app-native'
  terminalTarget: false
}

export const FIRSTMATE_RUNTIME_HOST: FirstMateRuntimeHost = {
  kind: 'ade-app',
  supervisor: 'app-native',
  terminalTarget: false
}

/** The pinned project on a task-scoped record: the request's project plus its disposable worktree. */
export type FirstMateRuntimeProject = FirstMateTaskContext['project'] & {
  worktree: string
}

export interface FirstMateRuntimeValidator {
  agent: AgentProvider
  model: string
  nmHome: string
  agentHome: string
  /** Present only on a task-scoped record that pins a per-task validator wrapper. */
  agentPath?: string
}

export interface FirstMateRuntimeRecord {
  version: typeof FIRSTMATE_RUNTIME_RECORD_VERSION
  host: FirstMateRuntimeHost
  project?: FirstMateRuntimeProject
  validator: FirstMateRuntimeValidator
}

/**
 * What a reader needs from a runtime record: the version gate it validated, and the pinned validator.
 * Producer-only operational fields (host, homes, project, worktree) are deliberately dropped — the
 * only ADE-side consumer distils the record to its validator, so additive fields are ignored, never
 * a reason to reject. An incompatible change is expressed by bumping {@link FIRSTMATE_RUNTIME_RECORD_VERSION}.
 */
export interface FirstMateRuntimeRecordView {
  version: typeof FIRSTMATE_RUNTIME_RECORD_VERSION
  validator: {
    agent: AgentProvider
    model: string
  }
}

/** JSON with a trailing newline and 0o600-friendly formatting, as every writer emits it today. */
export function serializeFirstMateRuntimeRecord(record: FirstMateRuntimeRecord): string {
  return `${JSON.stringify(record, null, 2)}\n`
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? value as Record<string, unknown> : undefined
}

/**
 * Reads a serialized runtime record, rejecting an unsupported version or a malformed required field
 * (the validator agent and model). Unknown additive fields are ignored, so a compatible v1 record
 * written by a newer producer still reads here.
 */
export function parseFirstMateRuntimeRecord(text?: string): FirstMateRuntimeRecordView | undefined {
  if (!text) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  const record = asRecord(parsed)
  const validator = asRecord(record?.validator)
  const agent = validator?.agent
  const model = validator?.model
  if (
    record?.version !== FIRSTMATE_RUNTIME_RECORD_VERSION
    || (agent !== 'codex' && agent !== 'claude')
    || typeof model !== 'string'
  ) {
    return undefined
  }
  return { version: FIRSTMATE_RUNTIME_RECORD_VERSION, validator: { agent, model } }
}
