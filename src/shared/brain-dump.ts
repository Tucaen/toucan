export type BrainDumpCollection = 'active' | 'archived'
export type BrainDumpOutcome = 'implemented' | 'resolved' | 'rejected' | 'obsolete'

export interface BrainDumpTopic {
  slug: string
  title: string
  created: string
  updated: string
  collection: BrainDumpCollection
  outcome?: BrainDumpOutcome
  archived?: string
  markdown: string
}

export interface BrainDumpDiagnostic {
  path: string
  code: string
  message: string
}

export interface BrainDumpListResult {
  topics: BrainDumpTopic[]
  diagnostics: BrainDumpDiagnostic[]
}

export type BrainDumpMutationResult = { ok: true; topic: BrainDumpTopic } | { ok: false; code: string; message: string }

export type BrainDumpReferenceResult =
  | { status: 'found'; slug: string; collection: BrainDumpCollection; topic: BrainDumpTopic }
  | { status: 'missing'; slug: string }
  | { status: 'conflict'; slug: string }
  | { status: 'invalid'; slug: string }
  | { status: 'invalid-topic'; slug: string; collection: BrainDumpCollection; message: string }

export interface BrainDumpApi {
  list(collection: BrainDumpCollection): Promise<BrainDumpListResult>
  resolve(slug: string): Promise<BrainDumpReferenceResult>
  archive(slug: string, outcome: BrainDumpOutcome): Promise<BrainDumpMutationResult>
  reopen(slug: string): Promise<BrainDumpMutationResult>
}

export const BRAIN_DUMP_OUTCOMES: readonly BrainDumpOutcome[] = ['implemented', 'resolved', 'rejected', 'obsolete']

export function isBrainDumpSlug(value: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)
}
