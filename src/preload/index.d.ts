import type { AgentApi, UsageApi } from '../shared/agent'
import type { TerminalApi } from '../shared/terminal'
import type { WorktreeApi } from '../shared/worktree'
import type { ConversationApi } from '../shared/conversation'
import type { WorkspaceFilesApi } from '../shared/workspace-files'
import type { RemoteApi } from '../shared/remote-api'
import type { BrainDumpApi } from '../shared/brain-dump'
import type { TicketFilesApi, TicketGithubApi } from '../shared/ticket-source'
import type { TicketSkillApi } from '../shared/ticket-skill'
import type { AppUpdateApi } from '../shared/app-update'
import type { VoiceModelApi } from '../shared/voice-model'
import type { FileViewApi } from '../shared/file-view'
import type { AdapterManagementApi } from '../shared/adapter-management'
import type { ProjectAvatarApi } from '../shared/project-avatar'
import type { TerminalContextApi } from '../shared/terminal-context'

/**
 * Only the `Window` augmentation lives here. Every `*Api` contract is a shared type that
 * `src/preload/index.ts` implements against, so the seam has exactly one copy of each signature.
 */
declare global {
  interface Window {
    adapterManagementApi: AdapterManagementApi
    terminalApi: TerminalApi
    terminalContextApi: TerminalContextApi
    projectAvatarApi: ProjectAvatarApi
    agentApi: AgentApi
    workspaceFilesApi: WorkspaceFilesApi
    usageApi: UsageApi
    worktreeApi: WorktreeApi
    conversationApi: ConversationApi
    remoteApi: RemoteApi
    brainDumpApi: BrainDumpApi
    ticketsApi: TicketFilesApi
    ticketSkillApi: TicketSkillApi
    githubIssuesApi: TicketGithubApi
    fileViewApi: FileViewApi
    appUpdateApi: AppUpdateApi
    voiceModelApi: VoiceModelApi
  }
}
