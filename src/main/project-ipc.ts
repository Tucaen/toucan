import { basename, normalize } from 'node:path'
import { PROJECT_CHANNELS, SHELL_CHANNELS, WORKSPACE_CHANNELS } from '../shared/ipc-channels'
import type { ProjectDirectory, WorkspaceLoadResult, WorkspaceSaveResult, WorkspaceState } from '../shared/terminal'
import type { IpcRegistrar } from './ipc-registrar'

/**
 * Everything the project/shell/workspace channels are wired to. The Electron pieces - the folder
 * dialog and `shell` - are injected so the decisions here (what names a project, which URLs may
 * leave the app, what a reveal is allowed to do) run under tests without a window.
 */
export interface ProjectIpcDependencies {
  workspace: {
    load(): Promise<WorkspaceLoadResult>
    save(state: WorkspaceState): Promise<WorkspaceSaveResult>
  }
  /** The directory the app was launched from; the default project a fresh workspace opens on. */
  initialProjectPath(): string
  /** Shows the OS folder picker owned by the asking window; null when the user cancels. */
  pickProjectDirectory(sender: unknown): Promise<string | null>
  openExternal(url: string): Promise<void>
  /** Selects a path in the OS file manager; never opens or executes it. */
  showItemInFolder(path: string): void
}

/** A directory as the sidebar displays it: its base name over its absolute path. */
function projectDirectory(path: string): ProjectDirectory {
  return { name: basename(path), path }
}

export function registerProjectIpc(ipc: IpcRegistrar, deps: ProjectIpcDependencies): void {
  ipc.handle(PROJECT_CHANNELS.initial, () => projectDirectory(deps.initialProjectPath()))
  ipc.handle(PROJECT_CHANNELS.pick, async (event) => {
    const picked = await deps.pickProjectDirectory(event.sender)
    return picked ? projectDirectory(normalize(picked)) : null
  })
  // Markdown links in agent replies must open in the user's browser; loading one in the
  // renderer would navigate the app window away. Only web URLs are forwarded - never file:,
  // and never a shell-interpreted scheme.
  ipc.handle(SHELL_CHANNELS.openExternal, async (_event, url: unknown) => {
    if (typeof url !== 'string') return
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return
    await deps.openExternal(parsed.toString())
  })
  // A file-operation tool card offers to reveal the file it touched. This only ever selects a
  // path in the OS file manager - it never opens or executes it.
  ipc.handle(SHELL_CHANNELS.showItemInFolder, (_event, path: unknown) => {
    if (typeof path !== 'string' || !path.trim()) return
    deps.showItemInFolder(normalize(path))
  })
  ipc.handle(WORKSPACE_CHANNELS.load, () => deps.workspace.load())
  ipc.handle(WORKSPACE_CHANNELS.save, (_event, state) => deps.workspace.save(state as WorkspaceState))
}
