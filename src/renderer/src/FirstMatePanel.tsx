import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react'
import type { AgentProvider } from '../../shared/agent'
import type {
  FirstMateExternalProject,
  FirstMateInstallResult,
  FirstMateLifecycleStatus,
  FirstMateLifecycleTask,
  FirstMateRuntimeStatus,
  FirstMateTaskStage,
  FirstMateWorkspaceState
} from '../../shared/firstmate'
import {
  firstMateActiveProvider,
  firstMateCaptainState,
  firstMateClosedDecisionIds,
  firstMateWithCaptainState
} from '../../shared/firstmate'
import type { WorkspaceProject } from '../../shared/terminal'
import { QuotaStat, UsageStat } from './AgentUsageStatus'
import { ChatView, SelectorPicker, type ChatViewProps } from './ChatNode'
import { firstMateProjectHint, firstMateProjectSelection, firstMateRequest } from './firstmate-project-catalog'
import {
  clampFirstMatePanelWidth,
  firstMatePanelWidthBounds,
  resizeFirstMatePanel,
  resizeFirstMatePanelWithKey,
  type FirstMatePanelResizeSession,
  type FirstMatePanelWidthBounds
} from './firstmate-panel-resize'
import { useAgentConversation } from './use-agent-conversation'
import { useFirstMateQuota } from './use-firstmate-quota'
import { durableTaskClosureState, pendingDecisionStateFromMessages } from './pending-decisions'

const FIRSTMATE_AGENT_ID = 'ade-firstmate'
const FIRSTMATE_PROVIDERS = [
  { id: 'codex', name: 'Codex' },
  { id: 'claude', name: 'Claude' }
] as const

interface FirstMateCaptainSelectorsProps {
  models: Parameters<typeof SelectorPicker>[0]['options']
  selectedModelId?: string
  efforts: Parameters<typeof SelectorPicker>[0]['options']
  selectedEffortId?: string
  modes: Parameters<typeof SelectorPicker>[0]['options']
  selectedModeId?: string
  disabled: boolean
  selectModel(modelId: string): void
  selectEffort(effortId: string): void
  selectMode(modeId: string): void
}

/** Captain controls in their fixed visual/tab order. */
export function FirstMateCaptainSelectors(props: FirstMateCaptainSelectorsProps): JSX.Element {
  return (
    <>
      <label>
        <span>Model</span>
        <SelectorPicker
          kind="model"
          options={props.models}
          selectedId={props.selectedModelId}
          disabled={props.disabled}
          select={props.selectModel}
        />
      </label>
      <label>
        <span>Thinking</span>
        <SelectorPicker
          kind="effort"
          options={props.efforts}
          selectedId={props.selectedEffortId}
          disabled={props.disabled}
          select={props.selectEffort}
        />
      </label>
      <label>
        <span>Permissions</span>
        <SelectorPicker
          kind="permission"
          options={props.modes}
          selectedId={props.selectedModeId}
          disabled={props.disabled}
          select={props.selectMode}
        />
      </label>
    </>
  )
}

interface FirstMateProviderTabsProps {
  activeProvider: AgentProvider
  switchingDisabled: boolean
  select(provider: AgentProvider): void
}

/** Two resumable captain conversations presented as tabs; only the selected captain is running. */
export function FirstMateProviderTabs({
  activeProvider,
  switchingDisabled,
  select
}: FirstMateProviderTabsProps): JSX.Element {
  const selectAt = (index: number): void => {
    if (switchingDisabled) return
    const provider = FIRSTMATE_PROVIDERS[index]?.id
    if (provider) select(provider)
  }
  const navigate = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    let target: number | undefined
    if (event.key === 'ArrowRight') target = (index + 1) % FIRSTMATE_PROVIDERS.length
    if (event.key === 'ArrowLeft') target = (index - 1 + FIRSTMATE_PROVIDERS.length) % FIRSTMATE_PROVIDERS.length
    if (event.key === 'Home') target = 0
    if (event.key === 'End') target = FIRSTMATE_PROVIDERS.length - 1
    if (target === undefined) return
    event.preventDefault()
    selectAt(target)
  }

  return (
    <div className="firstmate-provider-tabs" role="tablist" aria-label="FirstMate captain conversations">
      {FIRSTMATE_PROVIDERS.map((provider, index) => {
        const selected = provider.id === activeProvider
        const disabled = !selected && switchingDisabled
        return (
          <button
            type="button"
            role="tab"
            id={`firstmate-${provider.id}-tab`}
            aria-selected={selected}
            aria-controls="firstmate-active-conversation"
            tabIndex={selected ? 0 : -1}
            disabled={disabled}
            title={disabled
              ? `Wait for ${activeProvider === 'codex' ? 'Codex' : 'Claude'} to finish before switching captains.`
              : `${provider.name} has its own captain conversation and settings.`}
            key={provider.id}
            onClick={() => select(provider.id)}
            onKeyDown={(event) => navigate(event, index)}
          >
            <strong>{provider.name}</strong>
            <small>{selected ? 'Active captain' : 'Separate conversation'}</small>
          </button>
        )
      })}
    </div>
  )
}

function resizeAreaWidth(panel: HTMLElement | null): number {
  const panelRect = panel?.getBoundingClientRect()
  const canvasRect = panel?.previousElementSibling?.getBoundingClientRect()
  if (panelRect && canvasRect) return panelRect.width + canvasRect.width
  return panel?.parentElement?.getBoundingClientRect().width ?? window.innerWidth
}

interface FirstMatePanelProps {
  projects: WorkspaceProject[]
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
  install,
  repair
}: {
  runtime: FirstMateRuntimeStatus | null
  installing: boolean
  install(): void
  repair(): void
}): JSX.Element {
  // ADE hosts FirstMate through Windows' WSL host only, so elsewhere there is nothing to offer at all.
  if (runtime?.state === 'unsupported') {
    return (
      <div className="firstmate-runtime-setup">
        <FirstMateMark />
        <strong>FirstMate is unavailable on this platform</strong>
        <p>{runtime.message}</p>
      </div>
    )
  }
  const checking = runtime === null
  const failed = runtime?.state === 'error'
  const repairable = runtime?.state === 'repair'
  if (repairable) {
    return (
      <div className="firstmate-runtime-setup">
        <FirstMateMark />
        <strong>Repair FirstMate setup</strong>
        <p>{runtime.message}</p>
        <small>Existing projects, authentication, and task state are preserved.</small>
        <button type="button" onClick={repair} disabled={installing}>
          {installing ? 'Repairing…' : 'Repair setup'}
        </button>
      </div>
    )
  }
  return (
    <div className="firstmate-runtime-setup">
      <FirstMateMark />
      <strong>{checking ? 'Checking FirstMate…' : failed ? 'FirstMate setup failed' : 'Set up FirstMate'}</strong>
      <p>
        {checking
          ? 'Looking for ADE’s managed FirstMate distro and operational home.'
          : failed
          ? runtime.message
          : `ADE will provision FirstMate, Codex and Claude ACP, and tmux inside ${runtime.distribution ?? 'Ubuntu'}.`}
      </p>
      {!checking && !failed && (
        <small>Linux packages stay isolated inside WSL; ADE and its projects remain native Windows applications.</small>
      )}
      {!checking && (
        <button type="button" onClick={install} disabled={installing}>
          {installing ? 'Installing…' : failed ? 'Retry setup' : 'Set up in Ubuntu'}
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

export default function FirstMatePanel({ projects, project, state, onStateChange }: FirstMatePanelProps): JSX.Element {
  const [sessionGenerations, setSessionGenerations] = useState<Partial<Record<AgentProvider, number>>>({})
  const [runtime, setRuntime] = useState<FirstMateRuntimeStatus | null>(null)
  const [lifecycle, setLifecycle] = useState<FirstMateLifecycleStatus>({
    supervision: 'app-native',
    tasks: []
  })
  const [lifecycleLoaded, setLifecycleLoaded] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [waitingForGitHub, setWaitingForGitHub] = useState(false)
  const [releasingDispatch, setReleasingDispatch] = useState<string>()
  const [retryingDispatch, setRetryingDispatch] = useState<string>()
  const [openingTerminal, setOpeningTerminal] = useState<string>()
  const [enablingCodexHooks, setEnablingCodexHooks] = useState(false)
  const [codexHookError, setCodexHookError] = useState<string>()
  const [enablingFleetAccess, setEnablingFleetAccess] = useState(false)
  const [fleetAccessError, setFleetAccessError] = useState<string>()
  const [registration, setRegistration] = useState<FirstMateExternalProject | null>(null)
  const [registrationError, setRegistrationError] = useState<string>()
  const [authorizingInitialization, setAuthorizingInitialization] = useState(false)
  const [settingAutonomyCeiling, setSettingAutonomyCeiling] = useState(false)
  const [panelWidth, setPanelWidth] = useState(state.panelWidth)
  const [panelWidthBounds, setPanelWidthBounds] = useState<FirstMatePanelWidthBounds>(() => (
    firstMatePanelWidthBounds(window.innerWidth)
  ))
  const [resizing, setResizing] = useState(false)
  const panelRef = useRef<HTMLElement>(null)
  const resizeSession = useRef<(FirstMatePanelResizeSession & { pointerId: number }) | null>(null)
  // The sidebar selection is a hint for the next request; it is never a request or task binding.
  const activeProjectHint = firstMateProjectHint(project)

  useEffect(() => {
    let active = true
    void window.firstMateApi.status().then((status) => {
      if (!active) return
      if (status.state === 'repair') {
        setRuntime(status)
        setInstalling(true)
        void window.firstMateApi.repair().then((result) => {
          if (active) { setRuntime(result.status); setInstalling(false) }
        })
      } else {
        setRuntime(status)
      }
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
        if (active) {
          setLifecycle(status)
          setLifecycleLoaded(true)
        }
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
  const provider = firstMateActiveProvider(state)
  const captain = firstMateCaptainState(state, provider)
  const updateCaptain = (patch: Parameters<typeof firstMateWithCaptainState>[2]): void => {
    onStateChange(firstMateWithCaptainState(state, provider, patch))
  }
  const requiredFleetMode = provider === 'codex' ? 'agent-full-access' : 'bypassPermissions'

  const conversation = useAgentConversation({
    id: FIRSTMATE_AGENT_ID,
    provider,
    cwd: runtime?.distroPath ?? '',
    scope: 'firstmate',
    sessionId: captain.conversationId,
    permissionMode: captain.permissionMode,
    modelId: captain.modelId,
    effortId: captain.effortId,
    restartKey: sessionGenerations[provider] ?? 0,
    composePrompt: async (text) => {
      const requestProjects = await Promise.all(projects.map(async (catalogProject) => ({
        selection: catalogProject,
        registration: await window.firstMateApi.registerProject(firstMateProjectSelection(catalogProject))
      })))
      const activeRegistration = requestProjects.find(({ selection }) => selection.id === project.id)?.registration
      setRegistration(activeRegistration?.project ?? null)
      setRegistrationError(activeRegistration?.ok ? undefined : activeRegistration?.message)
      return firstMateRequest(requestProjects, project.id, text, {
        provider,
        model: captain.modelId,
        effort: captain.effortId
      })
    },
    enabled: runtime?.state === 'ready' && (provider !== 'codex' || runtime.codexProjectTrust === 'trusted'),
    onSessionId: (conversationId) => updateCaptain({
      conversationId,
      ...(captain.closedDecisionConversationId === conversationId
        ? {}
        : { closedDecisionConversationId: conversationId, closedDecisionIds: [] })
    }),
    onPermissionMode: (permissionMode) => updateCaptain({ permissionMode }),
    onModel: (modelId) => updateCaptain({ modelId }),
    onEffort: (effortId) => updateCaptain({ effortId })
  })
  const taskClosureState = lifecycleLoaded
    ? durableTaskClosureState(
        new Set(lifecycle.closedTaskIds),
        new Set(lifecycle.tasks.map((task) => task.id)),
        new Set(state.closedTaskIds)
      )
    : { closedTaskIds: new Set(state.closedTaskIds) }
  const { closedTaskIds } = taskClosureState
  const persistedClosedDecisionIds = firstMateClosedDecisionIds(state, provider, captain.conversationId)
  const decisionState = pendingDecisionStateFromMessages(
    conversation.messages,
    closedTaskIds,
    new Set(persistedClosedDecisionIds)
  )

  useEffect(() => {
    const nextDecisionIds = [...decisionState.closedIds]
    const nextClosedTaskIds = [...closedTaskIds]
    if ((captain.conversationId && nextDecisionIds.join('\0') !== persistedClosedDecisionIds.join('\0'))
      || nextClosedTaskIds.join('\0') !== (state.closedTaskIds ?? []).join('\0')) {
      onStateChange(firstMateWithCaptainState({
        ...state,
        closedTaskIds: nextClosedTaskIds
      }, provider, captain.conversationId
        ? {
            closedDecisionConversationId: captain.conversationId,
            closedDecisionIds: nextDecisionIds
          }
        : {}))
    }
  }, [
    captain.conversationId,
    closedTaskIds,
    decisionState.closedIds,
    onStateChange,
    provider,
    persistedClosedDecisionIds,
    state
  ])

  const runSetup = (action: () => Promise<FirstMateInstallResult>): void => {
    setInstalling(true)
    void action().then((result) => {
      setRuntime(result.status)
      setInstalling(false)
    })
  }

  const install = (): void => runSetup(() => window.firstMateApi.install())
  const repair = (): void => runSetup(() => window.firstMateApi.repair())

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

  const retryDispatch = (taskId: string): void => {
    setRetryingDispatch(taskId)
    void window.firstMateApi.retryDispatch(taskId).then((result) => {
      setRetryingDispatch(undefined)
      if (result.ok) return
      setLifecycle((current) => ({
        ...current,
        message: result.message ?? `ADE could not retry the validation dispatch for ${taskId}.`
      }))
    })
  }

  const viewWorkerTerminal = (taskId: string): void => {
    setOpeningTerminal(taskId)
    void window.firstMateApi.viewWorkerTerminal(taskId).then((result) => {
      setOpeningTerminal(undefined)
      if (result.ok) return
      setLifecycle((current) => ({
        ...current,
        message: result.message ?? `ADE could not open a terminal for ${taskId}.`
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

  const toggleAutonomyCeiling = (): void => {
    const allowed = !registration?.autonomyCeiling
    setSettingAutonomyCeiling(true)
    setRegistrationError(undefined)
    void window.firstMateApi.setAutonomyCeiling(project.id, allowed).then((result) => {
      if (result.project) setRegistration(result.project)
      if (!result.ok) setRegistrationError(result.message ?? 'ADE could not update the autonomy ceiling.')
      setSettingAutonomyCeiling(false)
    })
  }

  const startNewSession = (permissionMode?: string): void => {
    updateCaptain({
      conversationId: undefined,
      closedDecisionConversationId: undefined,
      closedDecisionIds: [],
      ...(permissionMode ? { permissionMode } : {})
    })
    setSessionGenerations((current) => ({
      ...current,
      [provider]: (current[provider] ?? 0) + 1
    }))
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
  const quota = useFirstMateQuota(provider, ready)
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
            title={`Discard this ${provider === 'codex' ? 'Codex' : 'Claude'} captain conversation and run FirstMate startup again`}
          >New session</button>
        )}
        <span className="chat-provider-badge">ACP</span>
      </header>
      {ready ? (
        <>
          <FirstMateProviderTabs
            activeProvider={provider}
            switchingDisabled={conversation.status === 'working' || conversation.status === 'starting'}
            select={(activeProvider) => updateState({ activeProvider })}
          />
          <div
            className="firstmate-project-hint"
            title={`${activeProjectHint.windowsPath}${registration ? `\n${registration.wslPath}` : ''}`}
          >
            <span>Active hint</span>
            <strong>{activeProjectHint.name}</strong>
            <small>{activeProjectHint.windowsPath}</small>
            {registration && (
              <em
                className="firstmate-project-posture"
                title={`Project name "${registration.registryName}"\n`
                  + `${registration.origin ? `origin ${registration.origin}` : 'no remote'}\n`
                  + `autonomy ${registration.autonomy ? 'on' : 'off'}`}
              >{registration.mode}{registration.autonomy ? ' +yolo' : ''}</em>
            )}
          </div>
          {registration && (
            <div className="firstmate-autonomy-policy">
              <span>
                {registration.postureSource === 'fleet-registry'
                  ? registration.autonomyCeiling
                    ? 'Fleet registry sets the standing posture. ADE authorizes autonomy.'
                    : 'Fleet registry sets the standing posture. ADE is vetoing autonomy.'
                  : registration.autonomyCeiling
                    ? 'ADE local policy allows autonomy for this project.'
                    : 'ADE local policy denies autonomy for this project.'}
              </span>
              <button
                type="button"
                onClick={toggleAutonomyCeiling}
                disabled={settingAutonomyCeiling}
              >
                {settingAutonomyCeiling
                  ? 'Updating…'
                  : registration.autonomyCeiling ? 'Deny autonomy' : 'Allow autonomy'}
              </button>
            </div>
          )}
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
            <FirstMateCaptainSelectors
              models={conversation.models?.availableModels ?? []}
              selectedModelId={conversation.models?.currentModelId}
              efforts={conversation.efforts?.availableEfforts ?? []}
              selectedEffortId={conversation.efforts?.currentEffortId}
              modes={conversation.modes?.availableModes ?? []}
              selectedModeId={conversation.modes?.currentModeId}
              disabled={conversation.selectorsDisabled}
              selectModel={conversation.selectModel}
              selectEffort={conversation.selectEffort}
              selectMode={conversation.selectMode}
            />
            <label>
              <span>Context</span>
              <UsageStat usage={conversation.usage} />
            </label>
            <label>
              <span>Limits</span>
              <QuotaStat quota={quota} />
            </label>
          </div>
          <div
            className="firstmate-worker-info"
            title="ADE delivers durable task wakes to this ACP conversation; no terminal pane is claimed as the captain."
          >
            Crew backend: tmux in {runtime.distribution ?? 'WSL'} · app-native wake
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
                  <button
                    type="button"
                    className="firstmate-view-terminal"
                    onClick={() => viewWorkerTerminal(task.id)}
                    disabled={openingTerminal === task.id}
                    title="Open a real terminal attached to this task's live worker tmux session."
                  >
                    {openingTerminal === task.id ? 'Opening…' : 'View terminal'}
                  </button>
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
                  {task.stage === 'blocked' && task.dispatch?.status === 'retryable' && (
                    <button
                      type="button"
                      onClick={() => retryDispatch(task.id)}
                      disabled={retryingDispatch === task.id}
                      title={
                        'Every delivery attempt failed before reaching FirstMate, so no validation started. '
                        + 'Retrying resets the attempt budget and re-sends the same dispatch identity.'
                      }
                    >
                      {retryingDispatch === task.id ? 'Retrying…' : 'Retry'}
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
          <div
            className="firstmate-conversation-panel"
            role="tabpanel"
            id="firstmate-active-conversation"
            aria-labelledby={`firstmate-${provider}-tab`}
          >
            <ChatView
              {...props}
              completedTaskIds={closedTaskIds}
              closedDecisionIds={new Set(persistedClosedDecisionIds)}
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
          </div>
        </>
      ) : (
        <RuntimeSetup runtime={runtime} installing={installing} install={install} repair={repair} />
      )}
    </aside>
  )
}
