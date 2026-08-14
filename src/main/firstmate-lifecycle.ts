import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  FirstMateLifecycleStatus,
  FirstMateLifecycleTask,
  FirstMateTaskStage,
  FirstMateValidatorRuntime
} from '../shared/firstmate'

export interface FirstMateRawTask {
  id: string
  meta: string
  status: string
}

export interface FirstMateLifecycleFiles {
  runtimeConfig?: string
  journal?: string
  tasks: FirstMateRawTask[]
}

export interface FirstMateLifecycleRecord {
  stage: FirstMateTaskStage
  detail: string
  statusHash: string
  nextAction?: FirstMateLifecycleTask['nextAction']
  prUrl?: string
  updatedAt: string
}

export interface FirstMateLifecycleJournal {
  version: 1
  tasks: Record<string, FirstMateLifecycleRecord>
}

const JOURNAL_FILE = '.ade-lifecycle.json'

function parseKeyValues(text: string): Map<string, string> {
  const values = new Map<string, string>()
  for (const line of text.split(/\r?\n/)) {
    const separator = line.indexOf('=')
    if (separator > 0) values.set(line.slice(0, separator), line.slice(separator + 1))
  }
  return values
}

function latestStatusLine(text: string): string {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1) ?? ''
}

function statusParts(line: string): { verb: string; detail: string } {
  const separator = line.indexOf(':')
  if (separator < 1) return { verb: '', detail: line }
  return { verb: line.slice(0, separator).trim(), detail: line.slice(separator + 1).trim() }
}

function statusHash(status: string): string {
  return createHash('sha256').update(status).digest('hex').slice(0, 20)
}

function parseJournal(text?: string): FirstMateLifecycleJournal {
  if (!text) return { version: 1, tasks: {} }
  try {
    const parsed = JSON.parse(text) as Partial<FirstMateLifecycleJournal>
    if (parsed.version !== 1 || !parsed.tasks || typeof parsed.tasks !== 'object') throw new Error()
    return { version: 1, tasks: parsed.tasks }
  } catch {
    return { version: 1, tasks: {} }
  }
}

export function firstMateValidatorFromRuntimeConfig(text?: string): FirstMateValidatorRuntime | undefined {
  if (!text) return undefined
  try {
    const parsed = JSON.parse(text) as {
      version?: unknown
      validator?: { agent?: unknown; model?: unknown }
    }
    const agent = parsed.validator?.agent
    const model = parsed.validator?.model
    if (parsed.version !== 1 || (agent !== 'codex' && agent !== 'claude') || typeof model !== 'string') {
      return undefined
    }
    return { agent, model, configSource: 'ade-runtime' }
  } catch {
    return undefined
  }
}

function prFromDone(verb: string, detail: string): string | undefined {
  if (verb !== 'done') return undefined
  const match = /\bPR\s+(https:\/\/[^\s]+)/i.exec(detail)
  return match?.[1]?.replace(/[),.;]+$/, '')
}

function recordedTask(
  raw: FirstMateRawTask,
  journal: FirstMateLifecycleJournal
): FirstMateLifecycleTask | undefined {
  const meta = parseKeyValues(raw.meta)
  if ((meta.get('kind') ?? 'ship') !== 'ship') return undefined
  const mode = meta.get('mode') ?? 'unknown'
  const line = latestStatusLine(raw.status)
  if (!line) return undefined
  const { verb, detail } = statusParts(line)
  const hash = statusHash(raw.status)
  const prUrl = prFromDone(verb, detail)

  if (prUrl) {
    return { id: raw.id, mode, stage: 'pr-ready', detail, statusHash: hash, nextAction: 'review-pr', prUrl }
  }
  if (verb === 'needs-decision') {
    return { id: raw.id, mode, stage: 'decision', detail, statusHash: hash, nextAction: 'await-decision' }
  }
  if (verb === 'blocked' || verb === 'failed') {
    return { id: raw.id, mode, stage: 'blocked', detail, statusHash: hash, nextAction: 'await-help' }
  }
  if (verb === 'working' && /validat|no-mistakes|checks|\bCI\b/i.test(detail)) {
    return { id: raw.id, mode, stage: 'validating', detail, statusHash: hash, nextAction: 'await-validation' }
  }

  const durable = journal.tasks[raw.id]
  if (verb === 'resolved' && mode === 'no-mistakes' && durable) {
    return {
      id: raw.id,
      mode,
      stage: 'validating',
      detail,
      statusHash: hash,
      nextAction: 'await-validation'
    }
  }
  if (durable && durable.statusHash === hash) {
    return {
      id: raw.id,
      mode,
      stage: durable.stage,
      detail: durable.detail,
      statusHash: hash,
      ...(durable.nextAction ? { nextAction: durable.nextAction } : {}),
      ...(durable.prUrl ? { prUrl: durable.prUrl } : {})
    }
  }
  if (verb === 'done') {
    return {
      id: raw.id,
      mode,
      stage: 'implemented',
      detail,
      statusHash: hash,
      ...(mode === 'no-mistakes' ? { nextAction: 'start-validation' as const } : {})
    }
  }
  return undefined
}

export function firstMateLifecycleFromFiles(files: FirstMateLifecycleFiles): FirstMateLifecycleStatus {
  const journal = parseJournal(files.journal)
  const validator = firstMateValidatorFromRuntimeConfig(files.runtimeConfig)
  const tasks = files.tasks
    .map((task) => recordedTask(task, journal))
    .filter((task): task is FirstMateLifecycleTask => task !== undefined)
    .sort((left, right) => left.id.localeCompare(right.id))
  return {
    supervision: 'app-native',
    ...(validator ? { validator } : {}),
    tasks
  }
}

async function optionalFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return undefined
  }
}

export async function readFirstMateLifecycleFiles(homePath: string): Promise<FirstMateLifecycleFiles> {
  const statePath = join(homePath, 'state')
  let names: string[] = []
  try {
    names = await readdir(statePath)
  } catch {
    // A newly provisioned home has no task state yet.
  }
  const ids = names.filter((name) => name.endsWith('.meta')).map((name) => name.slice(0, -5))
  const tasks = await Promise.all(ids.map(async (id) => ({
    id,
    meta: await optionalFile(join(statePath, `${id}.meta`)) ?? '',
    status: await optionalFile(join(statePath, `${id}.status`)) ?? ''
  })))
  return {
    runtimeConfig: await optionalFile(join(homePath, 'config', 'ade-runtime.json')),
    journal: await optionalFile(join(statePath, JOURNAL_FILE)),
    tasks
  }
}

export async function readFirstMateLifecycle(homePath: string): Promise<FirstMateLifecycleStatus> {
  return firstMateLifecycleFromFiles(await readFirstMateLifecycleFiles(homePath))
}

export async function recordFirstMateLifecycle(
  homePath: string,
  taskId: string,
  record: FirstMateLifecycleRecord
): Promise<void> {
  const statePath = join(homePath, 'state')
  await mkdir(statePath, { recursive: true })
  const current = parseJournal(await optionalFile(join(statePath, JOURNAL_FILE)))
  current.tasks[taskId] = record
  const temporary = join(statePath, `${JOURNAL_FILE}.${process.pid}.${crypto.randomUUID()}.tmp`)
  await writeFile(temporary, `${JSON.stringify(current, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, join(statePath, JOURNAL_FILE))
}

export function noMistakesInvocation(harness: string): string {
  if (/^codex(?:$|[-_])/.test(harness)) return '$no-mistakes'
  if (/^(claude|cursor|grok)(?:$|[-_])/.test(harness)) return '/no-mistakes'
  return 'Load the no-mistakes skill and continue validation now.'
}

export function noMistakesContinuation(harness: string, runtimeConfigPath: string): string {
  return `${noMistakesInvocation(harness)}\n\n`
    + `ADE has already selected the validator in ${runtimeConfigPath}. `
    + 'Use that structured runtime record and the propagated ADE_FIRSTMATE_VALIDATOR_AGENT and '
    + 'ADE_FIRSTMATE_VALIDATOR_MODEL values; do not infer the validator from filtered doctor text or guessed homes. '
    + 'Continue this committed task directly through validation and report decisions, blockers, failures, and PR readiness '
    + 'through the existing FirstMate authority boundary.'
}

export function firstMateAppWakeMessage(tasks: FirstMateLifecycleTask[]): string {
  const summary = tasks.map((task) => `${task.id}=${task.stage}`).join(', ')
  return `\u2063FIRSTMATE_OP: v1 ade-app-wake: Durable task lifecycle changed: ${summary}. `
    + 'ADE is the captain conversation host; reconcile the listed task status and preserve the existing authority boundary.'
}
