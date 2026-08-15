import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react'
import type {
  FirstMateExternalProject,
  FirstMateLifecycleStatus,
  FirstMateLifecycleTask,
  FirstMateRuntimeStatus,
  FirstMateTaskStage,
  FirstMateWorkspaceState
} from '../../shared/firstmate'
import type { WorkspaceProject } from '../../shared/terminal'
import { ChatView, SelectorPicker, type ChatViewProps } from './ChatNode'
import { firstMateProjectSelection, firstMateProjectTarget, firstMateRequest } from './firstmate-request-target'
import {
  clampFirstMatePanelWidth,
  firstMatePanelWidthBounds,
  resizeFirstMatePanel,
  resizeFirstMatePanelWithKey,
  type FirstMatePanelResizeSession,
  type FirstMatePanelWidthBounds
} from './firstmate-panel-resize'
import { useAgentConversation } from './use-agent-conversation'

const FIRSTMATE_AGENT_ID = 'ade-firstmate'
const FIRSTMATE_PROVIDERS = [
  { id: 'codex', name: 'Codex' },
  { id: 'claude', name: 'Claude' }
]

function resizeAreaWidth(panel: HTMLElement | null): number {
  const panelRect = panel?.getBoundingClientRect()
  const canvasRect = panel?.previousElementSibling?.getBoundingClientRect()
  if (panelRect && canvasRect) return panelRect.width + canvasRect.width
  return panel?.parentElement?.getBoundingClientRect().width ?? window.innerWidth
}

interface FirstMatePanelProps {
  project: WorkspaceProject
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

const lifecycleLabels: Record<FirstMateTaskStage, string> = {
  implemented: 'Implemented',
  dispatching: 'Dispatching',
  validating: 'Validating',
  decision: 'Decision',
  blocked: 'Blocked',
  'pr-ready': 'PR ready'
}

/**
 * The lifecycle row must say when a validation dispatch is merely claimed or unrecoverable by
 * ADE alone, so a stalled task is never mistaken for one that is quietly making progress.
 */
function lifecycleTaskLabel(task: FirstMateLifecycleTask): string {
  const stage = lifecycleLabels[task.stage]
  const dispatch = task.dispatch?.status === 'unresolved'
    ? ' · dispatch unresolved'
    : task.dispatch?.status === 'released'
      ? ' · dispatch released'
      : task.dispatch?.status === 'retryable' && task.stage === 'implemented'
        ? ' · dispatch retry'
        : ''
  const pinned = task.context
    ? ` · ${task.context.project.registryName} · ${task.context.validator.agent}/${task.context.validator.model}`
    : ''
  return `${stage}${dispatch}${pinned}`
}

export default function FirstMatePanel({ project, state, onStateChange }: FirstMatePanelProps): JSX.Element {
  const [sessionGeneration, setSessionGeneration] = useState(0)
  const [runtime, setRuntime] = useState<FirstMateRuntimeStatus | null>(null)
  const [lifecycle, setLifecycle] = useState<FirstMateLifecycleStatus>({
    supervision: 'app-native',
    tasks: []
  })
  const [installing, setInstalling] = useState(false)
  const [waitingForGitHub, setWaitingForGitHub] = useState(false)
  const [releasingDispatch, setReleasingDispatch] = useState<string>()
  const [enablingCodexHooks, setEnablingCodexHooks] = useState(false)
  const [codexHookError, setCodexHookError] = useState<string>()
  const [enablingFleetAccess, setEnablingFleetAccess] = useState(false)
  const [fleetAccessError, setFleetAccessError] = useState<string>()
  const [registration, setRegistration] = useState<FirstMateExternalProject | null>(null)
  const [registrationError, setRegistrationError] = useState<string>()
  const [authorizingInitialization, setAuthorizingInitialization] = useState(false)
  const [panelWidth, setPanelWidth] = useState(state.panelWidth)
  const [panelWidthBounds, setPanelWidthBounds] = useState<FirstMatePanelWidthBounds>(() => (
    firstMatePanelWidthBounds(window.innerWidth)
  ))
  const [resizing, setResizing] = useState(false)
  const panelRef = useRef<HTMLElement>(null)
  const resizeSession = useRef<(FirstMatePanelResizeSession & { pointerId: number }) | null>(null)
  // The sidebar selection retargets the next request; it is never part of the conversation's identity.
  const requestTarget = firstMateProjectTarget(project)

  useEffect(() => {
    let active = true
    void window.firstMateApi.status().then((status) => {
      if (active) setRuntime(status)
    })
    return () => { active = false }
  }, [])

  // Selecting a project only reads what ADE already recorded; registration happens on the request itself.
  useEffect(() => {
    if (runtime?.state !== 'ready') return
    let active = true
    setRegistrationError(undefined)
    void window.firstMateApi.recordedProject(project.id).then((recorded) => {
      if (active) setRegistration(recorded)
    })
    return () => { active = false }
  }, [project.id, runtime?.state])

  useEffect(() => {
    if (runtime?.state !== 'ready') return
    let active = true
    const refresh = (): void => {
      void window.firstMateApi.lifecycle().then((status) => {
        if (active) setLifecycle(status)
      })
    }
    refresh()
    const timer = window.setInterval(refresh, 2_500)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [runtime?.state])

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

  useEffect(() => {
    const fitPanelToWorkspace = (): void => {
      const bounds = firstMatePanelWidthBounds(resizeAreaWidth(panelRef.current))
      setPanelWidthBounds(bounds)
      setPanelWidth((current) => current === undefined ? current : clampFirstMatePanelWidth(current, bounds))
    }
    fitPanelToWorkspace()
    window.addEventListener('resize', fitPanelToWorkspace)
    return () => window.removeEventListener('resize', fitPanelToWorkspace)
  }, [])

  const updateState = (patch: Partial<FirstMateWorkspaceState>): void => {
    onStateChange({ ...state, ...patch })
  }
  const provider = state.provider ?? 'codex'
  const requiredFleetMode = provider === 'codex' ? 'agent-full-access' : 'bypassPermissions'

  const conversation = useAgentConversation({
    id: FIRSTMATE_AGENT_ID,
    provider,
    cwd: runtime?.distroPath ?? '',
    scope: 'firstmate',
    sessionId: sessionGeneration === 0 ? state.conversationId : undefined,
    permissionMode: state.permissionMode,
    modelId: state.modelId,
    restartKey: sessionGeneration,
    composePrompt: async (text) => {
      const result = await window.firstMateApi.registerProject(firstMateProjectSelection(project))
      setRegistration(result.project ?? null)
      setRegistrationError(result.ok ? undefined : result.message)
      if (!result.ok || !result.project) {
        throw new Error(result.message ?? `ADE could not resolve FirstMate project ${project.name} (${project.id}).`)
      }
      return firstMateRequest(project, text, {
        registration: result,
        provider,
        model: state.modelId
      })
    },
    enabled: runtime?.state === 'ready' && (provider !== 'codex' || runtime.codexProjectTrust === 'trusted'),
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

  const releaseDispatch = (taskId: string): void => {
    setReleasingDispatch(taskId)
    void window.firstMateApi.releaseDispatch(taskId).then((result) => {
      setReleasingDispatch(undefined)
      if (result.ok) return
      setLifecycle((current) => ({
        ...current,
        message: result.message ?? `ADE could not release the validation dispatch for ${taskId}.`
      }))
    })
  }

  const trustCodexProject = (): void => {
    setEnablingCodexHooks(true)
    setCodexHookError(undefined)
    void window.firstMateApi.trustCodexProject().then((result) => {
      if (!result.ok) {
        setCodexHookError(result.message ?? 'Codex hooks could not be enabled.')
        setRuntime((current) => current ? { ...current, message: result.message } : current)
        setEnablingCodexHooks(false)
        return
      }
      void window.firstMateApi.status().then((status) => {
        setRuntime(status)
        setEnablingCodexHooks(false)
      })
    })
  }

  const authorizeInitialization = (): void => {
    setAuthorizingInitialization(true)
    setRegistrationError(undefined)
    void window.firstMateApi.authorizeProjectInitialization(project.id).then((result) => {
      if (result.project) setRegistration(result.project)
      if (!result.ok) setRegistrationError(result.message ?? 'ADE could not record that authorization.')
      setAuthorizingInitialization(false)
    })
  }

  const startNewSession = (permissionMode?: string): void => {
    updateState({
      conversationId: undefined,
      ...(permissionMode ? { permissionMode } : {})
    })
    setSessionGeneration((current) => current + 1)
  }

  const enableFleetAccess = (): void => {
    setEnablingFleetAccess(true)
    setFleetAccessError(undefined)
    void conversation.selectMode(requiredFleetMode)
      .then((enabled) => {
        if (!enabled) {
          setFleetAccessError('ADE could not enable the provider\'s unrestricted fleet mode.')
          return
        }
        startNewSession(requiredFleetMode)
      })
      .catch((error: unknown) => {
        setFleetAccessError(error instanceof Error ? error.message : 'ADE could not enable fleet access.')
      })
      .finally(() => setEnablingFleetAccess(false))
  }

  const props: ChatViewProps = {
    provider,
    ...conversation
  }
  const ready = runtime?.state === 'ready'
  const displayStatus = statusLabel(conversation.status)

  const currentPanelWidth = (): number => {
    const measuredWidth = panelRef.current?.getBoundingClientRect().width ?? panelWidthBounds.min
    return clampFirstMatePanelWidth(panelWidth ?? measuredWidth, panelWidthBounds)
  }

  const startResize = (event: PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    const bounds = firstMatePanelWidthBounds(resizeAreaWidth(panelRef.current))
    const startWidth = clampFirstMatePanelWidth(
      panelRef.current?.getBoundingClientRect().width ?? panelWidth ?? bounds.min,
      bounds
    )
    resizeSession.current = { pointerId: event.pointerId, startX: event.clientX, startWidth, bounds }
    setPanelWidthBounds(bounds)
    setPanelWidth(startWidth)
    setResizing(true)
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const continueResize = (event: PointerEvent<HTMLDivElement>): void => {
    const session = resizeSession.current
    if (!session || session.pointerId !== event.pointerId) return
    event.preventDefault()
    event.stopPropagation()
    setPanelWidth(resizeFirstMatePanel(session, event.clientX))
  }

  const finishResize = (event: PointerEvent<HTMLDivElement>): void => {
    const session = resizeSession.current
    if (!session || session.pointerId !== event.pointerId) return
    event.preventDefault()
    event.stopPropagation()
    const width = resizeFirstMatePanel(session, event.clientX)
    resizeSession.current = null
    setPanelWidth(width)
    setResizing(false)
    updateState({ panelWidth: width })
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  const cancelResize = (event: PointerEvent<HTMLDivElement>): void => {
    const session = resizeSession.current
    if (!session || session.pointerId !== event.pointerId) return
    event.preventDefault()
    event.stopPropagation()
    resizeSession.current = null
    setPanelWidth(session.startWidth)
    setResizing(false)
  }

  const resizeWithKeyboard = (event: KeyboardEvent<HTMLDivElement>): void => {
    const width = resizeFirstMatePanelWithKey(currentPanelWidth(), event.key, panelWidthBounds)
    if (width === undefined) return
    event.preventDefault()
    event.stopPropagation()
    setPanelWidth(width)
    updateState({ panelWidth: width })
  }

  return (
    <aside
      ref={panelRef}
      className={`firstmate-panel firstmate-dock ${resizing ? 'is-resizing' : ''}`}
      aria-label="FirstMate conversation dock"
      style={panelWidth === undefined ? undefined : { width: panelWidth } as CSSProperties}
    >
      <div
        className="firstmate-resize-handle"
        role="separator"
        aria-label="Resize FirstMate panel"
        title="Drag to resize FirstMate"
        aria-orientation="vertical"
        aria-valuemin={panelWidthBounds.min}
        aria-valuemax={panelWidthBounds.max}
        aria-valuenow={Math.round(currentPanelWidth())}
        tabIndex={0}
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
        onContextMenu={(event) => {
          event.preventDefault()
          event.stopPropagation()
        }}
        onPointerDown={startResize}
        onPointerMove={continueResize}
        onPointerUp={finishResize}
        onPointerCancel={cancelResize}
        onLostPointerCapture={() => {
          resizeSession.current = null
          setResizing(false)
        }}
        onKeyDown={resizeWithKeyboard}
      />
      <header className="firstmate-panel-header">
        <FirstMateMark />
        <div>
          <strong>FirstMate</strong>
          <small><i data-status={conversation.status} />{ready ? displayStatus : 'ADE home'}</small>
        </div>
        {ready && (
          <button
            type="button"
            className="firstmate-new-session"
            onClick={() => startNewSession()}
            disabled={conversation.status === 'starting'}
            title="Discard this captain conversation and run FirstMate startup again"
          >New session</button>
        )}
        <span className="chat-provider-badge">ACP</span>
      </header>
      {ready ? (
        <>
          <div
            className="firstmate-request-target"
            title={`${requestTarget.windowsPath}\n${requestTarget.wslPath}`}
          >
            <span>Next request</span>
            <strong>{requestTarget.name}</strong>
            <small>{requestTarget.windowsPath}</small>
            {registration && (
              <em
                className="firstmate-project-posture"
                title={`Project name "${registration.registryName}"\n`
                  + `${registration.origin ? `origin ${registration.origin}` : 'no remote'}\n`
                  + `autonomy ${registration.autonomy ? 'on' : 'off'}`}
              >{registration.mode}{registration.autonomy ? ' +yolo' : ''}</em>
            )}
          </div>
          {registrationError && <div className="firstmate-lifecycle-error">{registrationError}</div>}
          {registration?.initialization === 'required' && (
            <div className="firstmate-auth-warning">
              <span>
                This project ships through no-mistakes, whose one-time gate setup writes inside
                {' '}{registration.windowsPath}. Selecting the project never changes it; ADE runs nothing
                {' '}in your checkout until you authorize that setup.
              </span>
              <button type="button" onClick={authorizeInitialization} disabled={authorizingInitialization}>
                {authorizingInitialization ? 'Authorizing...' : 'Authorize gate setup'}
              </button>
            </div>
          )}
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
          <div
            className="firstmate-worker-info"
            title="ADE delivers durable task wakes to this ACP conversation; no terminal pane is claimed as the captain."
          >
            Crew backend: tmux{runtime.host === 'wsl' ? ` in ${runtime.distribution ?? 'WSL'}` : ''} · app-native wake
          </div>
          {(lifecycle.tasks.length > 0 || lifecycle.message) && (
            <section className="firstmate-lifecycle" aria-label="FirstMate task lifecycle">
              <header>
                <strong>Delivery lifecycle</strong>
                {lifecycle.validator && (
                  <small>{lifecycle.validator.agent} · {lifecycle.validator.model}</small>
                )}
              </header>
              {lifecycle.message && <div className="firstmate-lifecycle-error">{lifecycle.message}</div>}
              {lifecycle.tasks.map((task) => (
                <div
                  className="firstmate-lifecycle-task"
                  data-stage={task.stage}
                  data-dispatch={task.dispatch?.status}
                  key={task.id}
                  title={task.detail}
                >
                  <span>{task.id}</span>
                  <strong>{lifecycleTaskLabel(task)}</strong>
                  {task.dispatch?.status === 'unresolved' && (
                    <button
                      type="button"
                      onClick={() => releaseDispatch(task.id)}
                      disabled={releasingDispatch === task.id}
                      title={
                        'ADE cannot tell whether this continuation reached FirstMate. Releasing it resends '
                        + 'the same dispatch identity, so a worker that already received it can ignore the repeat.'
                      }
                    >
                      {releasingDispatch === task.id ? 'Releasing…' : 'Release'}
                    </button>
                  )}
                </div>
              ))}
            </section>
          )}
          {provider === 'codex' && runtime.codexProjectTrust === 'required' && (
            <div className="firstmate-auth-warning">
              <span>
                {codexHookError ?? (
                  <>
                    Codex needs permission to run FirstMate&apos;s repository hooks in ADE&apos;s isolated Codex profile.
                    These hooks attach the session to the FirstMate harness and enforce its fleet lock.
                  </>
                )}
              </span>
              <button type="button" onClick={trustCodexProject} disabled={enablingCodexHooks}>
                {enablingCodexHooks ? 'Enabling...' : 'Enable Codex hooks'}
              </button>
            </div>
          )}
          {conversation.modes && conversation.modes.currentModeId !== requiredFleetMode && (
            <div className="firstmate-auth-warning">
              <span>
                {fleetAccessError ?? (
                  <>
                    Full FirstMate fleet operation requires unrestricted command, filesystem, and network access.
                    ADE will apply the provider&apos;s full-access mode and start a fresh captain session.
                  </>
                )}
              </span>
              <button type="button" onClick={enableFleetAccess} disabled={enablingFleetAccess}>
                {enablingFleetAccess ? 'Enabling...' : 'Enable fleet access'}
              </button>
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
