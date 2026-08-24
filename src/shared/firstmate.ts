import type { AgentProvider } from './agent'
import type { FirstMateTaskContext } from './firstmate-task-context'

export const FIRSTMATE_PANEL_MIN_WIDTH = 300

/**
 * Not an upper bound on the resizable panel width - the panel may grow to fill the workspace,
 * limited only by `FIRSTMATE_CANVAS_MIN_WIDTH`. This is purely the fallback estimate
 * `firstMatePanelWidthBounds` uses when the workspace width isn't known yet.
 */
export const FIRSTMATE_PANEL_MAX_WIDTH = 720

/**
 * `unsupported` is terminal by design: ADE integrates FirstMate through Windows' WSL host only, so
 * every other platform has no install, launch, or registration path at all. A future cross-platform
 * host is a new supported feature with its own state, never a fallback reached from here.
 */
export type FirstMateRuntimeState = 'missing' | 'repair' | 'installing' | 'ready' | 'error' | 'unsupported'

export type FirstMateTaskStage =
  | 'implemented'
  | 'dispatching'
  | 'validating'
  | 'decision'
  | 'blocked'
  | 'pr-ready'

/**
 * Outcome of one validation dispatch attempt, as far as ADE can prove it durably.
 *
 * `claimed` records the intent to invoke the external continuation before it runs, so a
 * crash can never be mistaken for a task that still needs dispatching. `unresolved` is the
 * recoverable end state for a claim whose outcome cannot be established after a restart:
 * the continuation may already have run, so ADE refuses to send it a second time until an
 * operator says otherwise, which makes it `released` and resends the same identity.
 */
export type FirstMateDispatchStatus =
  | 'claimed'
  | 'acknowledged'
  | 'retryable'
  | 'unresolved'
  | 'released'

export interface FirstMateTaskDispatch {
  id: string
  status: FirstMateDispatchStatus
  attempt: number
  message?: string
}

export interface FirstMateValidatorRuntime {
  agent: AgentProvider
  model: string
  configSource: 'ade-runtime'
}

export interface FirstMateLifecycleTask {
  id: string
  mode: string
  /** Immutable request configuration copied into FirstMate's durable task metadata. */
  context?: FirstMateTaskContext
  /** The isolated worker checkout recorded by FirstMate at spawn time. */
  worktree?: string
  /** The tmux session:window FirstMate recorded for this task's live worker, if any. */
  window?: string
  stage: FirstMateTaskStage
  detail: string
  statusHash: string
  nextAction?:
    | 'start-validation'
    | 'await-dispatch'
    | 'await-validation'
    | 'await-decision'
    | 'await-help'
    | 'review-pr'
  dispatch?: FirstMateTaskDispatch
  prUrl?: string
  history?: FirstMateTaskHistoryEvent[]
  terminalOutcome?: 'completed' | 'cancelled' | 'failed' | 'indeterminate'
}

export interface FirstMateTaskHistoryEvent {
  /** Stable evidence identity used to coalesce replayed lifecycle input. */
  id: string
  occurredAt: string
  source: 'firstmate-status' | 'ade-reconciliation' | 'forge'
  stage: FirstMateTaskStage
  detail: string
  dispatch?: FirstMateTaskDispatch
  outcome?: 'completed' | 'cancelled' | 'failed' | 'indeterminate'
}

export interface FirstMateLifecycleStatus {
  supervision: 'app-native'
  validator?: FirstMateValidatorRuntime
  message?: string
  tasks: FirstMateLifecycleTask[]
  closedTaskIds?: string[]
}

export interface FirstMateRuntimeStatus {
  state: FirstMateRuntimeState
  /** Where the managed distro and its private home live in the WSL host; absent when there is no host. */
  distroPath?: string
  homePath?: string
  backend: 'tmux'
  supervision: 'app-native'
  distribution?: string
  githubAuth?: 'authenticated' | 'required'
  codexProjectTrust?: 'trusted' | 'required'
  message?: string
}

export interface FirstMateInstallResult {
  ok: boolean
  status: FirstMateRuntimeStatus
}

export interface FirstMateActionResult {
  ok: boolean
  message?: string
}

/**
 * The outcome of one attempt to deliver a validation continuation to FirstMate, told apart by where
 * the attempt stopped rather than collapsed into a boolean.
 *
 * `rejected-before-send` failed while ADE was still preparing the dispatch, so nothing reached
 * FirstMate and the same stable identity is safe to send again automatically. `acknowledged` means
 * the external send completed. `indeterminate` covers a timeout, a process failure after the send
 * began, or a lost acknowledgement: the continuation may already be running, so ADE must never send
 * it again on its own and hands recovery to an operator instead.
 */
export type FirstMateValidationDelivery =
  | { outcome: 'acknowledged' }
  | { outcome: 'rejected-before-send'; message: string }
  | { outcome: 'indeterminate'; message: string }

/** The forges ADE knows how to ask about a PR's real merge state, named by their URL host. */
export type FirstMateForge = 'github'

/** What a live PR actually is, as far as its forge reports it. */
export type FirstMatePullRequestState = 'open' | 'merged' | 'closed'

/**
 * The outcome of one attempt to ask a forge whether a `pr-ready` task's PR merged or closed. `ok:
 * false` covers every soft failure this reconciliation must fail open on - the forge tool missing,
 * unauthenticated, rate-limited, or erroring - so the caller always has a single check for "leave
 * the task exactly as it is today" instead of distinguishing failure causes it cannot act on anyway.
 */
export type FirstMatePullRequestCheck =
  | { ok: true; state: FirstMatePullRequestState }
  | { ok: false }

/**
 * FirstMate's registered delivery postures, in the vocabulary owned by the managed distro's
 * `bin/fm-project-mode.sh`. `no-mistakes-prod-only` is a conditional policy rather than a flat mode.
 */
export type FirstMateDeliveryMode = 'no-mistakes' | 'no-mistakes-prod-only' | 'direct-PR' | 'local-only'

/**
 * Whether no-mistakes initialization, which writes inside the checkout, has been authorized.
 * Registration only records the requirement; ADE never initializes a checkout on its own.
 */
export type FirstMateProjectInitialization = 'not-required' | 'required' | 'authorized'

/** What ADE knows about a sidebar project before it has been registered with FirstMate. */
export interface FirstMateProjectSelection {
  projectId: string
  name: string
  path: string
}

/**
 * Where the project's standing delivery posture and autonomy come from, so the UI can explain
 * precedence rather than just showing the effective value.
 */
export type FirstMatePostureSource = 'fleet-registry' | 'ade-recorded' | 'default'

/** One ADE checkout registered as a durable external FirstMate project. */
export interface FirstMateExternalProject {
  /** ADE's stable project identity; two projects may share every other display value. */
  adeProjectId: string
  /** The single-token name FirstMate's fleet registry and posture lookup use. */
  registryName: string
  displayName: string
  windowsPath: string
  wslPath: string
  origin?: string
  originClassification: FirstMateProjectOriginClassification
  mode: FirstMateDeliveryMode
  /** The effective autonomy: standing posture AND ADE's local authorization ceiling. */
  autonomy: boolean
  /** ADE's local authorization ceiling, user-controlled and persisted across restart. */
  autonomyCeiling: boolean
  postureSource: FirstMatePostureSource
  initialization: FirstMateProjectInitialization
  registeredAt: string
}

export type FirstMateProjectOriginClassification = 'remote-backed' | 'local-only' | 'unsupported-inert'

/** One dispatchable project in the machine-readable catalog ADE gives the FirstMate captain. */
export interface FirstMateProjectCatalogEntry {
  adeProjectId: string
  registryName: string
  displayName: string
  canonicalPaths: {
    windows: string
    wsl: string
  }
  effectiveDeliveryPosture: FirstMateDeliveryMode
  autonomyPolicy: 'on' | 'off'
  originClassification: FirstMateProjectOriginClassification
  origin?: string
  initialization: FirstMateProjectInitialization
  /** Exact carrier to append only after the captain selects this entry for one task. */
  taskContextMetadata: string
}

export interface FirstMateProjectCatalog {
  version: 1
  activeProjectHint: {
    adeProjectId: string
    role: 'hint-only'
  }
  validator: {
    agent: AgentProvider
    model: string
  }
  projects: FirstMateProjectCatalogEntry[]
  unavailableProjects: Array<{
    adeProjectId: string
    displayName: string
    reason: string
  }>
}

export interface FirstMateProjectRegistration {
  ok: boolean
  project?: FirstMateExternalProject
  message?: string
  failure?: {
    kind: 'selection' | 'conversion' | 'path-access' | 'git' | 'registration' | 'wsl'
    adeProjectId: string
  }
}

/** One quota-axi usage window, trimmed to what the UI needs to show permanently. */
export interface FirstMateQuotaWindow {
  percentRemaining: number
  resetsAt: string
}

/**
 * The account-wide hourly (`five_hour`) and weekly (`seven_day`) usage-limit windows quota-axi
 * reports for a provider. `unavailable` covers quota-axi missing, unauthenticated, erroring, or
 * simply not reporting either window for this provider - the UI (`QuotaStat`) treats it as a real
 * failure worth a visible marker, distinct from `null` ("hasn't polled yet"), rather than folding
 * both into one silent dash.
 */
export interface FirstMateQuotaStatus {
  state: 'ok' | 'unavailable'
  provider: AgentProvider
  session?: FirstMateQuotaWindow
  week?: FirstMateQuotaWindow
  message?: string
}

/** Provider-owned state for one persistent FirstMate captain conversation. */
export interface FirstMateCaptainWorkspaceState {
  conversationId?: string
  permissionMode?: string
  modelId?: string
  /** Provider/model-specific thought level selected from the captain agent's ACP capabilities. */
  effortId?: string
  closedDecisionConversationId?: string
  closedDecisionIds?: string[]
}

export interface FirstMateWorkspaceState {
  /** Exactly one captain is active, but each provider keeps its own resumable conversation state. */
  activeProvider?: AgentProvider
  captains?: Partial<Record<AgentProvider, FirstMateCaptainWorkspaceState>>
  worklogCollapsed?: boolean
  panelWidth?: number
  closedTaskIds?: string[]
}

export function firstMateActiveProvider(state: FirstMateWorkspaceState): AgentProvider {
  return state.activeProvider ?? 'codex'
}

export function firstMateCaptainState(
  state: FirstMateWorkspaceState,
  provider: AgentProvider
): FirstMateCaptainWorkspaceState {
  return state.captains?.[provider] ?? {}
}

export function firstMateClosedDecisionIds(
  state: FirstMateWorkspaceState,
  provider: AgentProvider,
  conversationId: string | undefined
): readonly string[] {
  const captain = firstMateCaptainState(state, provider)
  return conversationId && captain.closedDecisionConversationId === conversationId
    ? captain.closedDecisionIds ?? []
    : []
}

/** Updates one provider's captain without disturbing the other provider or dock-wide presentation state. */
export function firstMateWithCaptainState(
  state: FirstMateWorkspaceState,
  provider: AgentProvider,
  patch: Partial<FirstMateCaptainWorkspaceState>
): FirstMateWorkspaceState {
  return {
    ...state,
    captains: {
      ...state.captains,
      [provider]: { ...firstMateCaptainState(state, provider), ...patch }
    }
  }
}
