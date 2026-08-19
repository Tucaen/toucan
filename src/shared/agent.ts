export type AgentProvider = 'claude' | 'codex'

export interface AgentCreateRequest {
  id: string
  provider: AgentProvider
  cwd: string
  scope?: 'project' | 'firstmate'
  sessionId?: string
  permissionMode?: string
  modelId?: string
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

export interface AgentActivity {
  id: string
  /** Omitted by patch-style ACP updates when the existing title is unchanged. */
  title?: string
  kind?: string
  status?: 'pending' | 'in_progress' | 'completed' | 'failed'
  content?: string
  locations?: string[]
}

export type AgentEvent =
  | { type: 'status'; status: 'starting' | 'ready' | 'working' | 'idle' | 'auth_required' | 'exited'; message?: string }
  | { type: 'session'; sessionId: string }
  | { type: 'message'; role: 'user' | 'assistant' | 'thought'; messageId: string; text: string }
  | { type: 'activity'; activity: AgentActivity }
  | { type: 'plan'; entries: AgentPlanEntry[] }
  | { type: 'modes'; modes: AgentModeState }
  | { type: 'models'; models: AgentModelState }
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
