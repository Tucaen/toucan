export type AgentProvider = 'claude' | 'codex'

export interface AgentCreateRequest {
  id: string
  provider: AgentProvider
  cwd: string
  scope?: 'project'
  sessionId?: string
  permissionMode?: string
  modelId?: string
  effortId?: string
}

export interface AgentAuthMethod {
  id: string
  name: string
  description?: string
  type: 'agent' | 'terminal' | 'env_var'
  args?: string[]
}

export interface AgentCreateResult {
  ok: boolean
  status: 'ready' | 'auth_required' | 'error'
  sessionId?: string
  modes?: AgentModeState
  models?: AgentModelState
  efforts?: AgentEffortState
  /** Commands already advertised by the time the session opened, so a reopen isn't left blank. */
  commands?: AgentCommand[]
  authMethods?: AgentAuthMethod[]
  /** Whether the agent's `initialize` handshake advertised `promptCapabilities.image`. */
  imageSupport?: boolean
  message?: string
}

export interface AgentPromptResult {
  ok: boolean
  message?: string
}

export interface AgentPromptTextBlock {
  type: 'text'
  text: string
}

export interface AgentPromptImageBlock {
  type: 'image'
  /** Base64-encoded image bytes, without the `data:` URL prefix. */
  data: string
  mimeType: string
}

export type AgentPromptBlock = AgentPromptTextBlock | AgentPromptImageBlock

/** What a prompt submission can carry: plain text (the common case) or content blocks mixing text and images. */
export type AgentPromptContent = string | AgentPromptBlock[]

export interface AgentMode {
  id: string
  name: string
  description?: string
}

export interface AgentModeState {
  currentModeId: string
  availableModes: AgentMode[]
}

export interface AgentModel {
  id: string
  name: string
  description?: string
}

export interface AgentModelState {
  currentModelId: string
  availableModels: AgentModel[]
}

export interface AgentEffortState {
  currentEffortId: string
  availableEfforts: AgentModel[]
}

/**
 * One slash command or skill the connected session advertises over ACP. Mirrors the protocol's
 * `AvailableCommand`; `input` is present only when the command expects arguments, and its `hint`
 * is what the agent suggests typing there.
 */
export interface AgentCommand {
  name: string
  description: string
  input?: { hint: string }
}

export interface AgentPermissionOption {
  id: string
  label: string
  kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always'
}

export interface AgentPlanEntry {
  content: string
  priority: 'high' | 'medium' | 'low'
  status: 'pending' | 'in_progress' | 'completed'
}

/** One before/after pair an agent reported for a file, as ACP `diff` content. */
export interface AgentFileDiff {
  path: string
  /** Absent when the diff describes a newly created file. */
  oldText?: string
  newText: string
}

export interface AgentActivity {
  id: string
  /** Omitted by patch-style ACP updates when the existing title is unchanged. */
  title?: string
  kind?: string
  status?: 'pending' | 'in_progress' | 'completed' | 'failed'
  content?: string
  locations?: string[]
  /**
   * The programmatic tool name (`Read`, `Edit`, ...) when the adapter reports one. `kind` says
   * only what family of thing happened; the name is what lets a card know which arguments to
   * expect in `rawInput`.
   */
  toolName?: string
  /**
   * The tool's own arguments, verbatim from ACP. Carried because a title and a path throw away
   * everything a purpose-built card needs - the read range, the write payload, the strings an
   * edit swapped. The shape is provider- and tool-specific, so every reader parses it
   * defensively (see `file-operation.ts`).
   */
  rawInput?: unknown
  /** Before/after pairs from ACP `diff` content, when the adapter sends them. */
  diffs?: AgentFileDiff[]
  /** Stamped locally by `mergeActivity` when the call is first seen; ACP reports no timing. */
  startedAt?: number
  /** Stamped when the call first reaches a terminal status, and cleared again if it resumes. */
  endedAt?: number
}

/**
 * One provider usage window, normalized across providers. Claude reports a single window per
 * `rate_limit_event` (tagged `five_hour` / `seven_day`); Codex reports up to two windows tagged
 * only by length in minutes. Both collapse into these two named slots.
 */
export interface AgentRateLimitWindow {
  /** Percentage of the window consumed, 0-100. */
  usedPercent: number
  /** Epoch milliseconds when the window resets, when the provider reports one. */
  resetsAt?: number
}

export interface AgentRateLimitStatus {
  fiveHour?: AgentRateLimitWindow
  weekly?: AgentRateLimitWindow
  /** Set when the provider has actively refused a request, not merely warned. */
  rejected?: boolean
}

/** Latest known usage-limit status per provider, keyed by `AgentProvider`. */
export type ProviderRateLimits = Partial<Record<AgentProvider, AgentRateLimitStatus>>

export type AgentEvent =
  | { type: 'status'; status: 'starting' | 'ready' | 'working' | 'idle' | 'auth_required' | 'exited'; message?: string }
  | { type: 'session'; sessionId: string }
  | { type: 'message'; role: 'user' | 'assistant' | 'thought'; messageId: string; text: string }
  | { type: 'activity'; activity: AgentActivity }
  | { type: 'plan'; entries: AgentPlanEntry[] }
  | { type: 'modes'; modes: AgentModeState }
  | { type: 'models'; models: AgentModelState }
  | { type: 'efforts'; efforts: AgentEffortState | null }
  | { type: 'commands'; commands: AgentCommand[] }
  | { type: 'approval'; approvalId: string; title: string; options: AgentPermissionOption[] }
  | { type: 'auth'; methods: AgentAuthMethod[] }
  | { type: 'auth_link'; url: string }
  | { type: 'usage'; used?: number; size?: number; cost?: string }
  | { type: 'turn_complete'; stopReason: string }
  | { type: 'error'; message: string }

export interface AgentEventEnvelope {
  id: string
  event: AgentEvent
}
