import type { WebContents } from 'electron'
import type { AgentCreateRequest, AgentPromptContent, AgentDecisionResponseContent } from '../shared/agent'
import { AGENT_CHANNELS } from '../shared/ipc-channels'
import type { AcpSessionManager } from './acp-session-manager'
import type { IpcEventRegistrar } from './ipc-registrar'
import { isRecord, isString, optionalString } from './ipc-validation'
import type { WorkspaceContainment } from './workspace-containment'

export function isAgentCreateRequest(value: unknown): value is AgentCreateRequest {
  if (!isRecord(value) || !isString(value.id) || !isString(value.cwd)) return false
  if (value.provider !== 'claude' && value.provider !== 'codex') return false
  if (value.scope !== undefined && value.scope !== 'project') return false
  if (![value.sessionId, value.forkFromSessionId, value.permissionMode, value.modelId, value.effortId].every(optionalString))
    return false
  if (value.sessionId !== undefined && value.forkFromSessionId !== undefined) return false
  if (value.additionalDirectories !== undefined &&
    (!Array.isArray(value.additionalDirectories) || !value.additionalDirectories.every(isString))) return false
  if (value.routineDelegation !== undefined &&
    (!isRecord(value.routineDelegation) || !isString(value.routineDelegation.workerModelId) ||
      !optionalString(value.routineDelegation.workerEffortId))) return false
  return value.decisionDelegation === undefined || value.decisionDelegation === true
}

function isPrompt(value: unknown): value is AgentPromptContent {
  return typeof value === 'string' || (Array.isArray(value) && value.every((block) =>
    isRecord(block) && ((block.type === 'text' && typeof block.text === 'string') ||
      (block.type === 'image' && typeof block.data === 'string' && isString(block.mimeType)))))
}

function isDecision(value: unknown): value is AgentDecisionResponseContent {
  return isRecord(value) && Object.values(value).every((entry) =>
    typeof entry === 'string' || typeof entry === 'boolean' ||
    (typeof entry === 'number' && Number.isFinite(entry)) ||
    (Array.isArray(entry) && entry.every((item) => typeof item === 'string')))
}

const INVALID_REQUEST = { ok: false, message: 'Invalid agent request.' }

/** Renderer input is narrowed before a session can launch or receive a command. */
export function registerAgentIpc(
  ipc: IpcEventRegistrar<WebContents>,
  manager: AcpSessionManager,
  containment: Pick<WorkspaceContainment, 'contains'>
): void {
  ipc.handle(AGENT_CHANNELS.create, async (event, request) => {
    if (!isAgentCreateRequest(request)) return { ...INVALID_REQUEST, status: 'error' }
    for (const path of [request.cwd, ...(request.additionalDirectories ?? [])]) {
      if (!(await containment.contains(path)))
        return { ok: false, status: 'error', message: 'Agent directory is outside the workspace.' }
    }
    return manager.create(request, event.sender)
  })
  for (const channel of ['prompt', 'promptWhenIdle'] as const) {
    ipc.handle(AGENT_CHANNELS[channel], (_event, id, content) =>
      isString(id) && isPrompt(content) ? manager[channel](id, content) : INVALID_REQUEST)
  }
  for (const channel of ['setMode', 'setModel', 'setEffort', 'authenticate', 'submitAuthCode'] as const) {
    ipc.handle(AGENT_CHANNELS[channel], (_event, id, value) =>
      isString(id) && isString(value) ? manager[channel](id, value) : INVALID_REQUEST)
  }
  ipc.handle(AGENT_CHANNELS.openAuthLink, (_event, url) => {
    if (isString(url)) return manager.openAuthLink(url)
  })
  ipc.on(AGENT_CHANNELS.approval, (_event, id, approvalId, optionId) => {
    if (isString(id) && isString(approvalId) && optionalString(optionId))
      manager.resolveApproval(id, approvalId, optionId)
  })
  ipc.on(AGENT_CHANNELS.elicitation, (_event, id, requestId, content) => {
    if (isString(id) && isString(requestId) && (content === undefined || isDecision(content)))
      manager.resolveElicitation(id, requestId, content)
  })
  for (const channel of ['cancel', 'kill'] as const) {
    ipc.on(AGENT_CHANNELS[channel], (_event, id) => {
      if (isString(id)) manager[channel](id)
    })
  }
}
