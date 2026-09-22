/**
 * The single home of every IPC channel name crossing the privilege seam. Main registers on these,
 * preload invokes/sends/subscribes on them, and nothing else may spell a channel out: a typo is a
 * type error at the one definition instead of a silent runtime no-op on one side of the seam.
 * Grouped per capability, mirroring the `*Api` contract each group carries.
 */

export const ADAPTER_CHANNELS = {
  state: 'adapters:state',
  check: 'adapters:check',
  select: 'adapters:select',
  changed: 'adapters:changed'
} as const

export const PROJECT_CHANNELS = {
  pick: 'project:pick',
  avatarChoose: 'project:avatar-choose',
  avatarRead: 'project:avatar-read',
  avatarRemove: 'project:avatar-remove'
} as const

export const SHELL_CHANNELS = {
  openExternal: 'shell:open-external',
  showItemInFolder: 'shell:show-item-in-folder',
  openLocalFile: 'shell:open-local-file',
  saveImage: 'shell:save-image'
} as const

export const WORKSPACE_CHANNELS = {
  load: 'workspace:load',
  save: 'workspace:save',
  fileIndex: 'workspace:file-index'
} as const

export const TERMINAL_CHANNELS = {
  create: 'terminal:create',
  write: 'terminal:write',
  resize: 'terminal:resize',
  kill: 'terminal:kill',
  scrollback: 'terminal:scrollback',
  scrollbackRemove: 'terminal:scrollback-remove',
  data: 'terminal:data',
  exit: 'terminal:exit'
} as const

export const AGENT_CHANNELS = {
  create: 'agent:create',
  prompt: 'agent:prompt',
  promptWhenIdle: 'agent:prompt-when-idle',
  setMode: 'agent:set-mode',
  setModel: 'agent:set-model',
  setEffort: 'agent:set-effort',
  authenticate: 'agent:authenticate',
  submitAuthCode: 'agent:submit-auth-code',
  openAuthLink: 'agent:open-auth-link',
  approval: 'agent:approval',
  elicitation: 'agent:elicitation',
  cancel: 'agent:cancel',
  kill: 'agent:kill',
  event: 'agent:event'
} as const

export const TERMINAL_CONTEXT_CHANNELS = {
  /** Full-set replace of the canvas's terminal-context edges; see `shared/terminal-context.ts`. */
  replaceEdges: 'terminal-context:replace-edges'
} as const

export const USAGE_CHANNELS = {
  rateLimits: 'usage:rate-limits'
} as const

export const WORKTREE_CHANNELS = {
  create: 'worktree:create',
  status: 'worktree:status',
  remove: 'worktree:remove',
  discover: 'worktree:discover',
  diff: 'worktree:diff',
  diffFile: 'worktree:diff-file',
  currentBranch: 'worktree:current-branch',
  listBranches: 'worktree:list-branches',
  checkoutBranch: 'worktree:checkout-branch'
} as const

export const CONVERSATION_CHANNELS = {
  list: 'conversation:list',
  exists: 'conversation:exists',
  setTitle: 'conversation:set-title'
} as const

export const REMOTE_CHANNELS = {
  state: 'remote:state',
  applySettings: 'remote:apply-settings',
  regenerateToken: 'remote:regenerate-token',
  publishWorkspace: 'remote:publish-workspace',
  stateChanged: 'remote:state-changed',
  /** Main asks the renderer to spawn on this; the renderer answers on `spawnChatResult`. */
  spawnChat: 'remote:spawn-chat',
  spawnChatResult: 'remote:spawn-chat-result',
  /**
   * A phone reached a chat's content. One way only: the canvas applies its own read and republishes
   * the projection, which is the answer the phone is already polling for.
   */
  markChatRead: 'remote:mark-chat-read'
} as const

export const BRAIN_DUMP_CHANNELS = {
  list: 'brain-dump:list',
  resolve: 'brain-dump:resolve',
  archive: 'brain-dump:archive',
  assignProject: 'brain-dump:assign-project',
  captureStart: 'brain-dump:capture-start',
  captureCurrent: 'brain-dump:capture-current',
  captureApproval: 'brain-dump:capture-approval',
  captureCancel: 'brain-dump:capture-cancel',
  captureEvent: 'brain-dump:capture-event',
  libraryChange: 'brain-dump:library-change'
} as const

export const TICKET_CHANNELS = {
  list: 'tickets:list',
  setStatus: 'tickets:set-status',
  remove: 'tickets:remove',
  isGitRepository: 'tickets:is-git-repository',
  reveal: 'tickets:reveal',
  changed: 'tickets:changed',
  skillState: 'tickets:skill-state',
  writeSkill: 'tickets:write-skill',
  revealSkill: 'tickets:reveal-skill'
} as const

export const DECISION_DELEGATION_CHANNELS = {
  availability: 'decision-delegation:availability'
} as const

export const GITHUB_ISSUES_CHANNELS = {
  availability: 'github-issues:availability',
  list: 'github-issues:list'
} as const

export const FILE_VIEW_CHANNELS = {
  read: 'file-view:read',
  write: 'file-view:write',
  watch: 'file-view:watch',
  unwatch: 'file-view:unwatch',
  changed: 'file-view:changed'
} as const

export const APP_UPDATE_CHANNELS = {
  state: 'app-update:state',
  check: 'app-update:check',
  restart: 'app-update:restart',
  changed: 'app-update:changed'
} as const

export const VOICE_MODEL_CHANNELS = {
  state: 'voice-model:state',
  ensure: 'voice-model:ensure',
  transcribe: 'voice-model:transcribe',
  changed: 'voice-model:changed'
} as const

export const DICTATION_CLEANUP_CHANNELS = {
  clean: 'dictation-cleanup:clean',
  cancel: 'dictation-cleanup:cancel'
} as const
