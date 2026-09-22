import { render, screen } from '@testing-library/react'
import { vi } from 'vitest'
import App from '../../src/renderer/src/App'
import type { WorkspaceState } from '../../src/shared/terminal'
import { createMockAppUpdateApi } from './app-update-api-mock'
import { createMockBrainDumpApi } from './brain-dump-api-mock'
import { createMockRemoteApi } from './remote-api-mock'

/**
 * Mounting the whole `App` is how the panel and sidebar tests reach their subject, and each of them
 * used to carry its own copy of the ~40 lines that make that possible: a saved workspace, a
 * `window` full of preload bridges, a ResizeObserver, and a render that waits for the sidebar. The
 * copies drifted - a new member on a bridge is a crash in every screen test, and the fix landed in
 * whichever copy the author was in. `tests/dom/setup.ts` and `tests/dom/xterm-mock.ts` already
 * solved that for one API and for xterm; this is the rest of it (#238).
 *
 * The default bridges answer and stay quiet, so a test only names the one it is actually about.
 */

export interface HarnessProject {
  id: string
  name: string
  path: string
  color: string
  avatarVersion?: number
}

export const DEFAULT_PROJECT: HarnessProject = {
  id: 'toucan',
  name: 'Toucan',
  path: 'D:\\Development\\Toucan',
  color: '#71a9ff'
}

/** A version-3 workspace holding one project and nothing on the canvas. */
export function savedWorkspace(overrides: Partial<WorkspaceState> = {}): WorkspaceState {
  return {
    version: 3,
    projects: [DEFAULT_PROJECT],
    activeProjectId: DEFAULT_PROJECT.id,
    sidebarCollapsed: false,
    nodes: [],
    worktrees: [],
    ...overrides
  }
}

export interface AppHarness {
  /** The workspace `loadWorkspace` answers with. */
  state: WorkspaceState
  /** Every snapshot that reached `saveWorkspace`, in the order it arrived. */
  saved: WorkspaceState[]
}

export interface AppHarnessOptions {
  state?: WorkspaceState
  /**
   * Per-bridge overrides, merged member by member over the defaults - so a test can replace one
   * spy (`copyText`) without restating the bridge, and a bridge with no default (`ticketsApi`) is
   * installed as given. Every mock here is a plain object literal, which is what makes the merge
   * total.
   */
  apis?: Record<string, Record<string, unknown>>
  /** Defaults to 1920. A resize mid-test goes through `setWindowWidth`. */
  windowWidth?: number
}

/** jsdom keeps `innerWidth` at 1024, which is narrower than several panels' minimum. */
export function setWindowWidth(width: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width })
}

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

/**
 * Installs the preload bridges on `window` and returns the harness state. Call it directly only
 * when the test needs something between installing the bridges and rendering; otherwise use
 * `renderApp`, which does both.
 */
export function installWindowApis(options: AppHarnessOptions = {}): AppHarness {
  const state = options.state ?? savedWorkspace()
  const saved: WorkspaceState[] = []
  const firstProject = state.projects[0] ?? DEFAULT_PROJECT

  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
  setWindowWidth(options.windowWidth ?? 1920)

  const defaults: Record<string, Record<string, unknown>> = {
    terminalApi: {
      loadWorkspace: vi.fn(async () => ({ state, recovered: false, unrecoverable: false })),
      saveWorkspace: vi.fn(async (snapshot: WorkspaceState) => {
        saved.push(snapshot)
        return { ok: true }
      }),
      getInitialProject: vi.fn(async () => ({ name: firstProject.name, path: firstProject.path })),
      create: vi.fn(async (request: { sessionId?: string }) => ({
        ok: true,
        sessionId: request.sessionId,
        incarnationId: `incarnation-${request.sessionId}`,
        liveness: 'live'
      })),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      scrollback: vi.fn(async () => null),
      removeScrollback: vi.fn(async () => true),
      onData: () => () => undefined,
      onExit: () => () => undefined,
      openExternal: vi.fn(),
      showItemInFolder: vi.fn(),
      copyText: vi.fn()
    },
    usageApi: { rateLimits: vi.fn(async () => ({})) },
    worktreeApi: {
      discover: vi.fn(async () => ({ worktrees: [], claims: [] })),
      status: vi.fn(async () => null)
    },
    conversationApi: { setTitle: vi.fn(async () => null) },
    agentApi: { onEvent: () => () => undefined },
    terminalContextApi: { replaceEdges: vi.fn() },
    appUpdateApi: createMockAppUpdateApi() as unknown as Record<string, unknown>,
    remoteApi: createMockRemoteApi() as unknown as Record<string, unknown>,
    brainDumpApi: createMockBrainDumpApi() as unknown as Record<string, unknown>
  }

  const names = new Set([...Object.keys(defaults), ...Object.keys(options.apis ?? {})])
  for (const name of names) {
    Object.defineProperty(window, name, {
      configurable: true,
      value: { ...defaults[name], ...options.apis?.[name] }
    })
  }

  return { state, saved }
}

/** Installs the bridges, mounts `App`, and waits for the sidebar to have rendered. */
export async function renderApp(options: AppHarnessOptions = {}): Promise<AppHarness> {
  const harness = installWindowApis(options)
  render(<App />)
  await screen.findByText('Add project')
  return harness
}
