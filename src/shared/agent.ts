import type { AgentProvider } from './agent-provider'
import type { AgentRoutineDelegation, RoutineDelegationRequest } from './routine-delegation'

export type { AgentProvider }

export interface AgentCreateRequest {
  id: string
  provider: AgentProvider
  cwd: string
  scope?: 'project'
  sessionId?: string
  permissionMode?: string
  modelId?: string
  effortId?: string
  /**
   * Directories outside `cwd` the session may read and write as if they were the workspace. A
   * background job that files into an app-owned library declares it here, so the provider's sandbox
   * does not turn every write into a permission request nobody is watching for.
   */
  additionalDirectories?: string[]
  /**
   * The "Delegate routine work cheaply" policy for this session, present only when the preference
   * is enabled. Applied at adapter launch (Codex) or session creation/resume (Claude), so a change
   * takes effect on the next session creation or resume - never mid-turn.
   */
  routineDelegation?: RoutineDelegationRequest
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
  /**
   * The routine-delegation policy the session's adapter actually launched with (see
   * `shared/routine-delegation.ts`) - the launch-time truth, which a preference changed since
   * launch does not alter. Absent when the request carried no policy.
   */
  routineDelegation?: AgentRoutineDelegation
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

/**
 * One image in the conversation, whichever direction it travelled: pasted by the captain into a
 * prompt, returned by a tool call, or sent as an assistant content block. `id` is minted by
 * whoever folds it in and stays stable for the life of that message or tool call, so a thumbnail
 * keeps its React key while later patches arrive.
 *
 * `data` may be empty. ACP lets an adapter name an image it did not send bytes for - a URL-sourced
 * image reaches `agent_message_chunk` as `{ data: '', uri }` - so having bytes is a question every
 * reader has to ask rather than assume (`unavailableImageNote` in `image-attachment.ts` is where
 * that question is answered once, for every surface).
 */
export interface AgentImageAttachment {
  id: string
  /** Base64-encoded image bytes, without the `data:` URL prefix; empty when only a reference came. */
  data: string
  mimeType: string
  /** Where the image lives, when the adapter named one instead of sending its bytes. */
  uri?: string
}

/**
 * An image as ACP delivered it, before anything gave it the identity a thumbnail is keyed on. A
 * message's images arrive one chunk at a time and their only identity is the position they end up
 * in, which the chunk itself cannot know - so minting the id belongs to the fold, not the wire.
 */
export type AgentImageContent = Omit<AgentImageAttachment, 'id'>

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

/**
 * Why a model cannot be changed right now, when the reason is a turn in flight.
 *
 * A conversation's model is fixed for the duration of a turn, and the refusal is the session
 * manager's (`setModel`) so every surface inherits one rule. It is worded here because both
 * pickers grey themselves out ahead of asking, and a control whose tooltip disagrees with the
 * refusal it would have got is worse than either wording alone.
 *
 * The reason it is refused rather than merely discouraged: a provider's prompt cache is
 * model-scoped, so a swap costs a full uncached re-read of the conversation, and a thinking block
 * is bound to the model that produced it - so a model joining a turn already in progress cannot
 * see the reasoning behind the tool calls it is expected to continue from.
 */
export const MODEL_CHANGE_WHILE_BUSY = 'Finish the turn first - a conversation keeps one model for the whole turn.'

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

export interface DelegationUsage {
  /** A worker invocation total, never a parent-session or per-message increment. */
  scope: 'worker-invocation'
  source: 'agent-result' | 'agent-result-trailer'
  total?: number
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
  reasoning?: number
}

export interface DelegationEvidence {
  requestedModel?: string
  confirmedModels?: string[]
  usage?: DelegationUsage
  /** Set of observed tool statuses, not an inferred retry count. */
  observedStatuses?: NonNullable<AgentActivity['status']>[]
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
   * Images this tool call returned, in the order ACP sent them. A generated image is ordinary
   * `image` content on the tool call, and a card that only reads `content` throws it away
   * entirely - which is how a finished image generation could present as a DONE card with no
   * output at all (issue #174). Replaced wholesale by a later patch that carries content, the
   * same way `content` is, because both adapters send a tool result's content once and complete.
   */
  images?: AgentImageAttachment[]
  /**
   * The tool call this one was made *inside* - set only on calls a subagent made, and naming the
   * `Task`/`Agent` call that spawned it. Both adapters forward a subagent's tool calls into the
   * same flat feed as the parent session's own, so without this every delegated Read and Grep
   * reads as the main agent's work and the spawning call looks frozen (see `subagent-task.ts`).
   */
  parentToolCallId?: string
  /** This call *is* a delegation: the adapter marked it as spawning a subagent. */
  subagent?: boolean
  /** Provider evidence folded with the activity, shared by live and replayed transcripts. */
  delegationEvidence?: DelegationEvidence
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
  /**
   * How long the window spans, in minutes, when the provider makes it knowable - Claude's
   * model-scoped buckets are weekly, Codex states each window's length outright. Without it the UI
   * can only show how much is used, never how close relief is.
   */
  windowMinutes?: number
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

/**
 * One provider's usage reading plus what the header needs in order to say anything about it beyond
 * the numbers. A reading kept after a failed refresh renders identically to a fresh one, so without
 * `readAt` and `stale` a refresh that silently failed and a refresh that found nothing new are the
 * same pixels - which is exactly how a working refresh comes to look broken.
 */
export interface ProviderUsageEntry {
  status: AgentRateLimitStatus
  /** When `status` came back from the provider. A read that failed leaves it where it was. */
  readAt: number
  /** True when the most recent read failed, so `status` is an older reading kept as a fallback. */
  stale: boolean
}

/** Latest usage reading per provider, keyed by `AgentProvider`. */
export type ProviderUsageReport = Partial<Record<AgentProvider, ProviderUsageEntry>>

/**
 * Demotes a reading to a kept fallback. Both the host (whose reader came back empty) and the
 * renderer (whose request never reached the host) have to make this call, so the rule lives here
 * rather than being written out on each side of the boundary.
 */
export function keptAsStale(entry: ProviderUsageEntry | undefined): ProviderUsageEntry | undefined {
  return entry && { ...entry, stale: true }
}

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
      /**
       * Images this chunk carried. ACP delivers an assistant's own image as a message chunk whose
       * content is an `image` block rather than a `text` one, so a chunk may have images and no
       * text at all; `foldMessage` appends them to the message the chunk belongs to.
       */
      images?: AgentImageContent[]
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

/** The agent capability, seen from the renderer. Preload implements it; main answers it. */
export interface AgentApi {
  create(request: AgentCreateRequest): Promise<AgentCreateResult>
  prompt(id: string, content: AgentPromptContent): Promise<AgentPromptResult>
  promptWhenIdle(id: string, content: AgentPromptContent): Promise<AgentPromptResult>
  setMode(id: string, modeId: string): Promise<AgentPromptResult>
  setModel(id: string, modelId: string): Promise<AgentPromptResult>
  setEffort(id: string, effortId: string): Promise<AgentPromptResult>
  authenticate(id: string, methodId: string): Promise<AgentCreateResult>
  submitAuthCode(id: string, code: string): Promise<AgentPromptResult>
  openAuthLink(url: string): Promise<void>
  resolveApproval(id: string, approvalId: string, optionId?: string): void
  resolveElicitation(id: string, requestId: string, content?: AgentDecisionResponseContent): void
  cancel(id: string): void
  kill(id: string): void
  onEvent(id: string, callback: (event: AgentEvent) => void): () => void
}

export interface UsageApi {
  /**
   * Account-wide plan usage windows per provider; omits a provider with nothing to report. Reads
   * are served from the host's cache unless `force` is set, which is what a user-initiated
   * refresh passes. Naming a `provider` reads only that one, so one provider's slow CLI never
   * decides how long another provider's chip sits disabled.
   */
  rateLimits(options?: { force?: boolean; provider?: AgentProvider }): Promise<ProviderUsageReport>
}
