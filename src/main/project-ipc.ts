import { basename, normalize } from 'node:path'
import { PROJECT_CHANNELS, SHELL_CHANNELS, WORKSPACE_CHANNELS } from '../shared/ipc-channels'
import type { ImageArtifactSaveRequest, ImageArtifactSaveResult } from '../shared/image-artifact'
import type { LocalFileOpenResult } from '../shared/local-file-link'
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
  /** Opens one local artifact with its associated application; decides for itself whether it may. */
  openLocalFile(path: string): Promise<LocalFileOpenResult>
  /** Writes one transcript image to a file the user picks; see `image-artifact.ts`. */
  saveImage(sender: unknown, request: ImageArtifactSaveRequest): Promise<ImageArtifactSaveResult>
}

/**
 * The save request as it arrives from the renderer - which is to say, unvalidated. Every field is
 * narrowed to the string it claims to be before it reaches the saver, which then decides on the
 * merits (see `imageArtifactBytes`) rather than trusting a shape.
 */
function imageSaveRequest(payload: unknown): ImageArtifactSaveRequest {
  const request = (payload ?? {}) as Partial<Record<keyof ImageArtifactSaveRequest, unknown>>
  return {
    data: typeof request.data === 'string' ? request.data : '',
    mimeType: typeof request.mimeType === 'string' ? request.mimeType : '',
    suggestedName: typeof request.suggestedName === 'string' ? request.suggestedName : 'image'
  }
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
  // and never a shell-interpreted scheme. A local path is the separate `openLocalFile` below,
  // which is narrow about what it will hand to the OS.
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
  // A Markdown link to an artifact the app has no view for - a generated image, an exported PDF -
  // opens it with the application the OS associates with it. The verdict is returned rather than
  // dropped, so a link to something missing says so instead of appearing to do nothing (#175).
  // Anything that is not a path is handed over as the empty one, so the opener stays the single
  // author of every refusal rather than this handler minting a second wording of the same one.
  ipc.handle(SHELL_CHANNELS.openLocalFile, (_event, path: unknown) =>
    deps.openLocalFile(typeof path === 'string' ? path : '')
  )
  // An image the agent produced lives in the transcript as bytes, and where the provider put its
  // own copy is provider-private. Saving one from those bytes is what makes it the reader's
  // regardless of whether the agent happened to mention a path (#174).
  ipc.handle(SHELL_CHANNELS.saveImage, (event, request: unknown) =>
    deps.saveImage(event.sender, imageSaveRequest(request))
  )
  ipc.handle(WORKSPACE_CHANNELS.load, () => deps.workspace.load())
  ipc.handle(WORKSPACE_CHANNELS.save, (_event, state) => deps.workspace.save(state as WorkspaceState))
}
