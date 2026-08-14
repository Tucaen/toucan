import { useEffect, useState } from 'react'
import type { FirstMateRuntimeStatus, FirstMateWorkspaceState } from '../../shared/firstmate'
import { ChatView, SelectorPicker, type ChatViewProps } from './ChatNode'
import { useAgentConversation } from './use-agent-conversation'

const FIRSTMATE_AGENT_ID = 'ade-firstmate'
const FIRSTMATE_PROVIDERS = [
  { id: 'codex', name: 'Codex' },
  { id: 'claude', name: 'Claude' }
]

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
      <strong>{checking ? 'Checking FirstMate…' : failed ? 'FirstMate setup failed' : 'Set up FirstMate'}</strong>
      <p>
        {checking
          ? 'Looking for ADE’s managed FirstMate distro and operational home.'
          : failed
          ? runtime.message
          : runtime?.host === 'wsl'
          ? `ADE will provision FirstMate, Codex and Claude ACP, and tmux inside ${runtime.distribution ?? 'Ubuntu'}.`
          : 'ADE will download the FirstMate agent distro and create one private operational home on this machine.'}
      </p>
      {runtime?.host === 'wsl' && !failed && (
        <small>Linux packages stay isolated inside WSL; ADE and its projects remain native Windows applications.</small>
      )}
      {!checking && (
        <button type="button" onClick={install} disabled={installing}>
          {installing ? 'Installing…' : failed ? 'Retry setup' : runtime?.host === 'wsl' ? 'Set up in Ubuntu' : 'Install from GitHub'}
        </button>
      )}
      {failed && <small>Existing files were preserved. Review the error above, then retry.</small>}
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
  const [waitingForGitHub, setWaitingForGitHub] = useState(false)

  useEffect(() => {
    let active = true
    void window.firstMateApi.status().then((status) => {
      if (active) setRuntime(status)
    })
    return () => { active = false }
  }, [])

  useEffect(() => {
    if (!waitingForGitHub || runtime?.githubAuth !== 'required') return
    const refresh = (): void => {
      void window.firstMateApi.status().then((status) => {
        setRuntime(status)
        if (status.githubAuth === 'authenticated') setWaitingForGitHub(false)
      })
    }
    const timer = window.setInterval(refresh, 3000)
    return () => window.clearInterval(timer)
  }, [runtime?.githubAuth, waitingForGitHub])

  const updateState = (patch: Partial<FirstMateWorkspaceState>): void => {
    onStateChange({ ...state, ...patch })
  }
  const provider = state.provider ?? 'codex'

  const conversation = useAgentConversation({
    id: FIRSTMATE_AGENT_ID,
    provider,
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

  const authenticateGitHub = (): void => {
    setWaitingForGitHub(true)
    void window.firstMateApi.authenticateGitHub().then((result) => {
      if (!result.ok) {
        setWaitingForGitHub(false)
        setRuntime((current) => current ? { ...current, message: result.message } : current)
      }
    })
  }

  const props: ChatViewProps = {
    provider,
    ...conversation
  }
  const ready = runtime?.state === 'ready'
  const displayStatus = statusLabel(conversation.status)

  return (
    <aside className="firstmate-panel firstmate-dock" aria-label="FirstMate conversation dock">
      <header className="firstmate-panel-header">
        <FirstMateMark />
        <div>
          <strong>FirstMate</strong>
          <small><i data-status={conversation.status} />{ready ? displayStatus : 'ADE home'}</small>
        </div>
        <span className="chat-provider-badge">ACP</span>
      </header>
      {ready ? (
        <>
          <div className="firstmate-settings-bar">
            <label>
              <span>Provider</span>
              <SelectorPicker
                kind="provider"
                options={FIRSTMATE_PROVIDERS}
                selectedId={provider}
                disabled={false}
                select={(selectedId) => {
                  if (selectedId !== 'codex' && selectedId !== 'claude') return
                  updateState({
                    provider: selectedId,
                    conversationId: undefined,
                    modelId: undefined,
                    permissionMode: undefined
                  })
                }}
              />
            </label>
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
          {runtime.host === 'wsl' && (
            <div className="firstmate-worker-info" title={runtime.message}>
              Crew backend: tmux in {runtime.distribution ?? 'WSL'}
            </div>
          )}
          {runtime.githubAuth === 'required' && conversation.status !== 'auth_required' && (
            <div className="firstmate-auth-warning">
              <span>GitHub sign-in is required for project and PR work.</span>
              <button type="button" onClick={authenticateGitHub} disabled={waitingForGitHub}>
                {waitingForGitHub ? 'Waiting for sign-in...' : 'Sign in to GitHub'}
              </button>
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
                {conversation.status !== 'auth_required' && (
                  <span><i data-tone={conversation.status === 'working' ? 'blue' : 'green'} />{displayStatus}</span>
                )}
                {conversation.approval && <span><i data-tone="gold" />1 decision</span>}
                <small>{conversation.activities.filter((activity) => activity.status === 'in_progress').length} active actions</small>
              </>
            )}
          />
          {conversation.detail && conversation.status !== 'auth_required' && (
            <div className="firstmate-detail" title={conversation.detail}>{conversation.detail}</div>
          )}
        </>
      ) : (
        <RuntimeSetup runtime={runtime} installing={installing} install={install} />
      )}
    </aside>
  )
}
