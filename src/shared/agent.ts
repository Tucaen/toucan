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
  /**
   * Transcript events emitted while a persisted session was loading. Returning them with the
   * create result makes replay atomic with session creation instead of racing a separate IPC
   * event channel during renderer startup.
   */
  replay?: AgentEvent[]
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

export interface AgentDecisionOption {
  value: string
  label: string
  description?: string
}

export interface AgentDecisionQuestion {
  id: string
  title?: string
  question: string
  options: AgentDecisionOption[]
  input: 'select' | 'text' | 'number' | 'boolean'
  multiSelect: boolean
  required?: boolean
  customAnswerId?: string
}

export interface AgentDecisionRequest {
  id: string
  message: string
  questions: AgentDecisionQuestion[]
}

export type AgentDecisionValue = string | string[] | number | boolean
export type AgentDecisionResponseContent = Record<string, AgentDecisionValue>

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
  /**
   * The tool's own result, verbatim from ACP's `rawOutput`. Carried for the same reason as
   * `rawInput`: it is where a shell call's exit code and its separated stdout/stderr live when
   * the adapter reports them structurally (see `shell-execution.ts`).
   */
  rawOutput?: unknown
  /** Before/after pairs from ACP `diff` content, when the adapter sends them. */
  diffs?: AgentFileDiff[]
  /**
   * The tool call this one was made *inside* - set only on calls a subagent made, and naming the
   * `Task`/`Agent` call that spawned it. Both adapters forward a subagent's tool calls into the
   * same flat feed as the parent session's own, so without this every delegated Read and Grep
   * reads as the main agent's work and the spawning call looks frozen (see `subagent-task.ts`).
   */
  parentToolCallId?: string
  /** This call *is* a delegation: the adapter marked it as spawning a subagent. */
  subagent?: boolean
  /**
   * One chunk of terminal output as the adapter just sent it - never the accumulated text. Both
   * adapters stream a command's output through the `terminal_output`/`terminal_output_delta`
   * `_meta` channel rather than ACP content, and `mergeActivity` is what appends chunks into
   * `terminalOutput`.
   */
  terminalChunk?: string
  /** Every chunk this call has produced, in order, folded by `mergeActivity`. */
  terminalOutput?: string
  /** The directory the command ran in, when the adapter reported one (`terminal_info.cwd`). */
  terminalCwd?: string
  /** The command's exit status, once the adapter reports the terminal exiting. */
  exitCode?: number
  /** The signal that killed the command instead, when there was one. */
  exitSignal?: string
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

/**
 * A window that meters one model family rather than the whole plan, such as Claude's weekly Fable
 * allowance. The provider names it, so the label is display text and never a slot key.
 */
export interface AgentModelRateLimitWindow extends AgentRateLimitWindow {
  label: string
}

export interface AgentRateLimitStatus {
  fiveHour?: AgentRateLimitWindow
  weekly?: AgentRateLimitWindow
  /** Per-model allowances, in the order the provider listed them; absent when the plan has none. */
  models?: AgentModelRateLimitWindow[]
  /** Set when the provider has actively refused a request, not merely warned. */
  rejected?: boolean
}

/** Latest known usage-limit status per provider, keyed by `AgentProvider`. */
export type ProviderRateLimits = Partial<Record<AgentProvider, AgentRateLimitStatus>>

/** Cumulative cost of one session, in whatever currency the provider bills it in. */
export interface AgentSessionCost {
  amount: number
  /** ISO 4217, e.g. `USD`. */
  currency: string
}

/** How assistant text should read in the transcript when the provider can distinguish it. */
export type AgentMessagePresentation = 'progress' | 'final'

/** A non-successful turn boundary that remains visible in the conversation transcript. */
export interface AgentTurnOutcome {
  id: string
  status: 'failed' | 'cancelled'
  message: string
}

export const AGENT_TURN_OUTCOME_LIMIT = 20

/** The single predicate for behavior that must be driven by completed assistant output only. */
export function isFinalAssistantMessage<
  T extends {
    role: string
    presentation?: AgentMessagePresentation
  }
>(message: T): message is T & { role: 'assistant' } {
  return message.role === 'assistant' && message.presentation !== 'progress'
}

export type AgentEvent =
  | { type: 'status'; status: 'starting' | 'ready' | 'working' | 'idle' | 'auth_required' | 'exited'; message?: string }
  | { type: 'session'; sessionId: string }
  | {
      type: 'message'
      role: 'user' | 'assistant' | 'thought'
      messageId: string
      text: string
      presentation?: AgentMessagePresentation
    }
  | { type: 'activity'; activity: AgentActivity }
  | { type: 'plan'; entries: AgentPlanEntry[] }
  | { type: 'modes'; modes: AgentModeState }
  | { type: 'models'; models: AgentModelState }
  | { type: 'efforts'; efforts: AgentEffortState | null }
  | { type: 'commands'; commands: AgentCommand[] }
  | { type: 'approval'; approvalId: string; title: string; options: AgentPermissionOption[]; activity?: AgentActivity }
  /** An approval was answered (by any client), so every subscriber retires the pending card. */
  | { type: 'approval_resolved'; approvalId: string }
  | { type: 'decision_request'; request: AgentDecisionRequest }
  | { type: 'decision_resolved'; requestId: string }
  | { type: 'auth'; methods: AgentAuthMethod[] }
  | { type: 'auth_link'; url: string }
  /**
   * ACP's `usage_update`, forwarded as reported rather than pre-formatted: tokens currently in
   * context, the model's context window, and the session's cumulative cost. The renderer decides
   * how to round and label all three (`session-usage.ts`). Codex reports no cost at all, and an
   * adapter that cannot determine the window omits `size`.
   */
  | { type: 'usage'; used?: number; size?: number; cost?: AgentSessionCost }
  | { type: 'turn_complete'; stopReason: string }
  | { type: 'turn_failed'; turnId: string; message: string }
  | { type: 'turn_cancelled'; turnId: string; message: string }
  | { type: 'error'; message: string }

export interface AgentEventEnvelope {
  id: string
  event: AgentEvent
}
