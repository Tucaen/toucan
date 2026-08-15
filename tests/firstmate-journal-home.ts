import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  FIRSTMATE_LIFECYCLE_JOURNAL_FILE,
  firstMateLifecycleFromFiles,
  type FirstMateLifecycleFiles,
  type FirstMateLifecycleJournal,
  type FirstMateLifecycleRecord
} from '../src/main/firstmate-lifecycle'
import type { FirstMateLifecycleStatus } from '../src/shared/firstmate'

/**
 * A local stand-in for the WSL node scripts in `src/main/firstmate-runtime.ts` that read and write
 * ADE's journal inside FirstMate's private home. No test may invoke WSL, so these give the
 * coordinator a real durable journal on this machine: a fresh coordinator over the same directory
 * reproduces an ADE restart, and only in-memory state is lost. Everything they hand the coordinator
 * is parsed by the shipped `firstMateLifecycleFromFiles`; only the file access is local.
 */

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
    journal: await optionalFile(join(statePath, FIRSTMATE_LIFECYCLE_JOURNAL_FILE)),
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
  const existing = await optionalFile(join(statePath, FIRSTMATE_LIFECYCLE_JOURNAL_FILE))
  const current: FirstMateLifecycleJournal = existing
    ? JSON.parse(existing) as FirstMateLifecycleJournal
    : { version: 1, tasks: {} }
  current.tasks[taskId] = record
  const temporary = join(statePath, `${FIRSTMATE_LIFECYCLE_JOURNAL_FILE}.${process.pid}.${crypto.randomUUID()}.tmp`)
  await writeFile(temporary, `${JSON.stringify(current, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, join(statePath, FIRSTMATE_LIFECYCLE_JOURNAL_FILE))
}
