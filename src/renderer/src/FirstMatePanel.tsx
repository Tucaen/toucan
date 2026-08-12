import { useEffect, useState } from 'react'
import type { FirstMateRuntimeStatus, FirstMateWorkspaceState } from '../../shared/firstmate'
import { ChatView, SelectorPicker, type ChatViewProps } from './ChatNode'
import { useAgentConversation } from './use-agent-conversation'

const FIRSTMATE_AGENT_ID = 'ade-firstmate'

interface FirstMatePanelProps {
  state: FirstMateWorkspaceState
  onStateChange(state: FirstMateWorkspaceState): void
}

function FirstMateMark(): JSX.Element {
  return <span className="firstmate-mark" aria-hidden="true">FM</span>
}

function RuntimeSetup({
  runtime,
  installing,
  install
}: {
  runtime: FirstMateRuntimeStatus | null
  installing: boolean
  install(): void
}): JSX.Element {
  const checking = runtime === null
  const failed = runtime?.state === 'error'
  return (
    <div className="firstmate-runtime-setup">
      <FirstMateMark />
      <strong>{checking ? 'Checking FirstMate…' : failed ? 'FirstMate setup failed' : 'Install FirstMate'}</strong>
      <p>
        {checking
          ? 'Looking for ADE’s managed FirstMate distro and operational home.'
          : failed
          ? runtime.message
          : 'ADE will download the FirstMate agent distro and create one private operational home on this machine.'}
      </p>
      {runtime?.workerSupport === 'wsl_required' && !failed && (
        <small>Windows crew workers require WSL with tmux and the FirstMate toolchain.</small>
      )}
      {!checking && (
        <button type="button" onClick={install} disabled={installing}>
          {installing ? 'Installing…' : failed ? 'Retry installation' : 'Install from GitHub'}
        </button>
      )}
      {failed && <small>The existing files were preserved. Resolve the path problem before retrying.</small>}
    </div>
  )
}

function statusLabel(status: ReturnType<typeof useAgentConversation>['status']): string {
  if (status === 'auth_required') return 'Sign in required'
  if (status === 'working') return 'Working'
  if (status === 'starting') return 'Starting'
  if (status === 'exited') return 'Unavailable'
  return 'Ready'
}

export default function FirstMatePanel({ state, onStateChange }: FirstMatePanelProps): JSX.Element {
  const [runtime, setRuntime] = useState<FirstMateRuntimeStatus | null>(null)
  const [installing, setInstalling] = useState(false)

  useEffect(() => {
    let active = true
    void window.firstMateApi.status().then((status) => {
      if (active) setRuntime(status)
    })
    return () => { active = false }
  }, [])

  const updateState = (patch: Partial<FirstMateWorkspaceState>): void => {
    onStateChange({ ...state, ...patch })
  }

  const conversation = useAgentConversation({
    id: FIRSTMATE_AGENT_ID,
    provider: 'codex',
    cwd: runtime?.distroPath ?? '',
    scope: 'firstmate',
    sessionId: state.conversationId,
    permissionMode: state.permissionMode,
    modelId: state.modelId,
    enabled: runtime?.state === 'ready',
    onSessionId: (conversationId) => updateState({ conversationId }),
    onPermissionMode: (permissionMode) => updateState({ permissionMode }),
    onModel: (modelId) => updateState({ modelId })
  })

  const install = (): void => {
    setInstalling(true)
    void window.firstMateApi.install().then((result) => {
      setRuntime(result.status)
      setInstalling(false)
    })
  }

  const props: ChatViewProps = {
    provider: 'codex',
    ...conversation
  }
  const ready = runtime?.state === 'ready'

  return (
    <aside className="firstmate-panel firstmate-dock" aria-label="FirstMate conversation dock">
      <header className="firstmate-panel-header">
        <FirstMateMark />
        <div>
          <strong>FirstMate</strong>
          <small><i data-status={conversation.status} />{ready ? statusLabel(conversation.status) : 'ADE home'}</small>
        </div>
        <span className="chat-provider-badge">ACP</span>
      </header>
      {ready ? (
        <>
          <div className="firstmate-settings-bar">
            <label>
              <span>Model</span>
              <SelectorPicker
                kind="model"
                options={conversation.models?.availableModels ?? []}
                selectedId={conversation.models?.currentModelId}
                disabled={conversation.selectorsDisabled}
                select={conversation.selectModel}
              />
            </label>
            <label>
              <span>Permissions</span>
              <SelectorPicker
                kind="permission"
                options={conversation.modes?.availableModes ?? []}
                selectedId={conversation.modes?.currentModeId}
                disabled={conversation.selectorsDisabled}
                select={conversation.selectMode}
              />
            </label>
          </div>
          {runtime.workerSupport === 'wsl_required' && (
            <div className="firstmate-worker-warning" title={runtime.message}>
              Crew backend: Linux or WSL required
            </div>
          )}
          <ChatView
            {...props}
            empty={{
              icon: 'FM',
              title: 'FirstMate is ready',
              description: 'Tell FirstMate what outcome you want across your projects.'
            }}
            worklogCollapsed={state.worklogCollapsed ?? true}
            setWorklogCollapsed={(worklogCollapsed) => updateState({ worklogCollapsed })}
            statusBar={(
              <>
                <span><i data-tone={conversation.status === 'working' ? 'blue' : 'green'} />{statusLabel(conversation.status)}</span>
                {conversation.approval && <span><i data-tone="gold" />1 decision</span>}
                <small>{conversation.activities.filter((activity) => activity.status === 'in_progress').length} active actions</small>
              </>
            )}
          />
          {conversation.detail && (
            <div className="firstmate-detail" title={conversation.detail}>{conversation.detail}</div>
          )}
        </>
      ) : (
        <RuntimeSetup runtime={runtime} installing={installing} install={install} />
      )}
    </aside>
  )
}
