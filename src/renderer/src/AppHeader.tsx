import { Settings, Smartphone } from 'lucide-react'
import type { RemoteAccessState } from '../../shared/remote-access'
import type { WorkspaceProject } from '../../shared/workspace'
import { AppUpdateChip } from './AppUpdateChip'
import { ProviderUsageChip } from './ProviderUsageChip'
import toucanLogo from './assets/toucan-logo.svg'
import type { AppUpdateController } from './use-app-update'
import type { ProviderRateLimitsState } from './use-provider-rate-limits'

/**
 * A line for the header's notice chip. `text` is what the chip shows, so it has to fit one; the
 * sentence that explains it goes in `detail` and is the chip's tooltip.
 */
export interface CanvasNotice {
  text: string
  detail: string
}

export interface AppHeaderProps {
  /** A global, always-visible read on the whole workspace - how many sessions are busy or stuck. */
  status: { working: number; stalled: number }
  unreadTotal: number
  /** The tooltip for the unread chip, from the same records every other unread surface counts. */
  describeUnread: () => string
  /** Whether the last workspace save failed - work that is not on disk, reported in every layout. */
  saveFailed: boolean
  notice: CanvasNotice | null
  onDismissNotice: () => void
  /** True while the canvas was restored from backup and the user has not dismissed the report. */
  recoveredFromBackup: boolean
  onDismissRecovery: () => void
  usage: Pick<ProviderRateLimitsState, 'providers' | 'refresh'>
  appUpdate: AppUpdateController
  remoteState: RemoteAccessState | null
  activeProject: WorkspaceProject | undefined
  onOpenAdapterManagement: () => void
  onOpenRemoteAccess: () => void
}

/**
 * The app header: brand, the global status summary, per-provider account usage, the update chip,
 * the adapter and remote-access buttons, and the active-project chip. Markup and wording only -
 * every figure arrives already decided, so this component holds no workspace state of its own.
 */
export function AppHeader({
  status,
  unreadTotal,
  describeUnread,
  saveFailed,
  notice,
  onDismissNotice,
  recoveredFromBackup,
  onDismissRecovery,
  usage,
  appUpdate,
  remoteState,
  activeProject,
  onOpenAdapterManagement,
  onOpenRemoteAccess
}: AppHeaderProps): JSX.Element {
  return (
    <header className="app-header">
      <div>
        <img className="brand-mark" src={toucanLogo} alt="" aria-hidden="true" />
        <strong>Toucan</strong>
        <span className="prototype-label">Agentic Development Environment</span>
      </div>
      <div className="header-target">
        {(status.working > 0 ||
          status.stalled > 0 ||
          unreadTotal > 0 ||
          saveFailed ||
          notice !== null ||
          recoveredFromBackup) && (
          <div className="global-status-summary" role="status">
            {status.working > 0 && (
              <span className="global-status-chip" data-kind="working">
                <span className="global-status-dot" />
                {status.working} working
              </span>
            )}
            {status.stalled > 0 && (
              <span
                className="global-status-chip"
                data-kind="stalled"
                title="No progress for a while - these sessions may be stuck"
              >
                <span className="global-status-dot" />
                {status.stalled} may be stuck
              </span>
            )}
            {/* Not recomputed from node status: this is the same durable record set the
                project rows and the nodes themselves count, so the numbers agree. */}
            {unreadTotal > 0 && (
              <span className="global-status-chip" data-kind="attention" title={describeUnread()}>
                <span className="global-status-dot" />
                {unreadTotal} unread
              </span>
            )}
            {/* In the header rather than the sidebar because the sidebar collapses and
                these two must not: a canvas that is not reaching disk is worth reporting in
                every layout the window has. */}
            {saveFailed && (
              <span
                className="global-status-chip"
                data-kind="save-error"
                title="The canvas could not be written to disk. Recent changes are only in memory until a save succeeds."
              >
                <span className="global-status-dot" />
                Save failed
              </span>
            )}
            {/* Whatever the canvas had to refuse or could not finish, said once and
                dismissible - the surface that replaced a `window.alert` per node. */}
            {notice !== null && (
              <button
                type="button"
                className="global-status-chip"
                data-kind="notice"
                title={`${notice.detail} Click to dismiss.`}
                onClick={onDismissNotice}
              >
                <span className="global-status-dot" />
                {notice.text}
              </button>
            )}
            {recoveredFromBackup && (
              <button
                type="button"
                className="global-status-chip"
                data-kind="recovered"
                title="The saved workspace was damaged or incomplete, so this canvas was restored from the last known-good backup. Click to dismiss."
                onClick={onDismissRecovery}
              >
                <span className="global-status-dot" />
                Recovered from backup
              </button>
            )}
          </div>
        )}
        {(usage.providers.claude || usage.providers.codex) && (
          <div className="global-usage-summary">
            {usage.providers.claude && (
              <ProviderUsageChip provider="claude" entry={usage.providers.claude} onRefresh={usage.refresh} />
            )}
            {usage.providers.codex && (
              <ProviderUsageChip provider="codex" entry={usage.providers.codex} onRefresh={usage.refresh} />
            )}
          </div>
        )}
        <AppUpdateChip
          snapshot={appUpdate.snapshot}
          announceError={appUpdate.announceError}
          busy={appUpdate.busy}
          onCheck={appUpdate.check}
          onRestart={appUpdate.restart}
        />
        <button
          type="button"
          className="header-remote-access"
          title="Agent adapters"
          aria-label="Agent adapters"
          onClick={(event) => {
            event.stopPropagation()
            onOpenAdapterManagement()
          }}
        >
          <Settings aria-hidden="true" />
        </button>
        <button
          type="button"
          className="header-remote-access"
          title={
            remoteState?.listening
              ? `Remote access is on (port ${remoteState.boundPort ?? remoteState.settings.port})`
              : 'Remote access is off - open to serve the mobile companion'
          }
          data-listening={remoteState?.listening ? 'true' : undefined}
          onClick={(event) => {
            event.stopPropagation()
            onOpenRemoteAccess()
          }}
        >
          <Smartphone aria-hidden="true" />
        </button>
        {activeProject && (
          <span className="target-chip" title={activeProject.path}>
            <span style={{ background: activeProject.color }} />
            {activeProject.name}
          </span>
        )}
      </div>
    </header>
  )
}
