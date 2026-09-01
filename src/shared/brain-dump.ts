export type BrainDumpCollection = 'active' | 'archived'
export type BrainDumpOutcome = 'implemented' | 'resolved' | 'rejected' | 'obsolete'

export interface BrainDumpTopic {
  slug: string
  title: string
  created: string
  updated: string
  collection: BrainDumpCollection
  projectPath?: string
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

export interface BrainDumpCaptureRequest {
  content: string
  provider: 'claude' | 'codex'
  projectPath?: string
}

export interface BrainDumpCaptureConversation {
  provider: 'claude' | 'codex'
  conversationId: string
  cwd: string
}

export type BrainDumpCaptureFailureCode = 'startup' | 'auth' | 'timeout' | 'cancelled' | 'skill' | 'unverifiable'

export type BrainDumpCaptureState =
  | { status: 'working'; jobId: string }
  | { status: 'completed'; jobId: string; summary: string; conversation: BrainDumpCaptureConversation }
  | {
      status: 'failed'
      jobId: string
      code: BrainDumpCaptureFailureCode
      message: string
      conversation?: BrainDumpCaptureConversation
    }

export type BrainDumpCaptureStartResult =
  | { ok: true; state: BrainDumpCaptureState }
  | { ok: false; code: 'invalid-content' | 'invalid-provider' | 'invalid-project' | 'busy'; message: string }

export type BrainDumpMutationResult = { ok: true; topic: BrainDumpTopic } | { ok: false; code: string; message: string }

export type BrainDumpReferenceResult =
  | { status: 'found'; slug: string; collection: BrainDumpCollection; topic: BrainDumpTopic }
  | { status: 'missing'; slug: string }
  | { status: 'conflict'; slug: string }
  | { status: 'invalid'; slug: string }
  | { status: 'invalid-topic'; slug: string; collection: BrainDumpCollection; message: string }

export interface BrainDumpLibraryApi {
  list(collection: BrainDumpCollection): Promise<BrainDumpListResult>
  resolve(slug: string): Promise<BrainDumpReferenceResult>
  archive(slug: string, outcome: BrainDumpOutcome): Promise<BrainDumpMutationResult>
  reopen(slug: string): Promise<BrainDumpMutationResult>
}

export interface BrainDumpApi extends BrainDumpLibraryApi {
  startCapture(request: BrainDumpCaptureRequest): Promise<BrainDumpCaptureStartResult>
  currentCapture(): Promise<BrainDumpCaptureState | null>
  cancelCapture(jobId: string): Promise<void>
  onCapture(callback: (state: BrainDumpCaptureState) => void): () => void
  onLibraryChange(callback: (collection: BrainDumpCollection) => void): () => void
}

export const BRAIN_DUMP_OUTCOMES: readonly BrainDumpOutcome[] = ['implemented', 'resolved', 'rejected', 'obsolete']

export function isBrainDumpSlug(value: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)
}

/** The one wording for each outcome, so a row and the archive dialog can never disagree. */
export const BRAIN_DUMP_OUTCOME_LABELS: Record<BrainDumpOutcome, string> = {
  implemented: 'Implemented',
  resolved: 'Resolved',
  rejected: 'Rejected',
  obsolete: 'Obsolete'
}
