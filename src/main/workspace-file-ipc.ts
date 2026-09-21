import { WORKSPACE_CHANNELS } from '../shared/ipc-channels'
import { emptyWorkspaceFileIndex } from '../shared/workspace-files'
import type { IpcRegistrar } from './ipc-registrar'
import type { WorkspaceContainment } from './workspace-containment'
import type { WorkspaceFileIndexReader } from './workspace-file-index'

/** The cached mention index uses the same workspace roots as file nodes. */
export function registerWorkspaceFileIpc(
  ipc: IpcRegistrar,
  files: WorkspaceFileIndexReader,
  containment: Pick<WorkspaceContainment, 'contains'>
): void {
  ipc.handle(WORKSPACE_CHANNELS.fileIndex, async (_event, root) =>
    typeof root === 'string' && await containment.contains(root)
      ? files.read(root)
      : emptyWorkspaceFileIndex(typeof root === 'string' ? root : ''))
}
