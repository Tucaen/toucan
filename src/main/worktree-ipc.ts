import { WORKTREE_CHANNELS } from '../shared/ipc-channels'
import type { GitChangedFile } from '../shared/git-diff'
import type { WorktreeManager } from './git-worktree'
import type { IpcRegistrar } from './ipc-registrar'
import { isRecord, isString, optionalString } from './ipc-validation'
import type { WorkspaceContainment } from './workspace-containment'
import { isAbsolute, resolve, relative } from 'node:path'

const MESSAGE = 'Invalid worktree request or path outside the workspace.'
const REFUSED = { ok: false, message: MESSAGE }

function isDiffFile(value: unknown): value is GitChangedFile {
  return (
    isRecord(value) &&
    isString(value.path) &&
    optionalString(value.oldPath) &&
    typeof value.status === 'string' &&
    ['added', 'modified', 'deleted', 'renamed', 'copied', 'type-changed', 'unmerged', 'untracked'].includes(
      value.status
    ) &&
    [value.added, value.deleted].every(
      (count) => count === undefined || (typeof count === 'number' && Number.isSafeInteger(count) && count >= 0)
    ) &&
    (value.binary === undefined || typeof value.binary === 'boolean')
  )
}

/** Git still proves worktree identity and teardown safety after this privilege boundary. */
export function registerWorktreeIpc(
  ipc: IpcRegistrar,
  worktrees: WorktreeManager,
  containment: Pick<WorkspaceContainment, 'contains'>
): void {
  const allowed = async (path: unknown): Promise<boolean> => isString(path) && (await containment.contains(path))
  ipc.handle(WORKTREE_CHANNELS.create, async (_event, request) => {
    if (
      !isRecord(request) ||
      !isString(request.projectPath) ||
      !isString(request.branch) ||
      !optionalString(request.baseRef) ||
      !(await allowed(request.projectPath))
    )
      return REFUSED
    return worktrees.create({ projectPath: request.projectPath, branch: request.branch, baseRef: request.baseRef })
  })
  ipc.handle(WORKTREE_CHANNELS.status, async (_event, request) => {
    if (
      !isRecord(request) ||
      !isString(request.path) ||
      !isString(request.branch) ||
      !isString(request.baseRef) ||
      !(await allowed(request.path))
    )
      return {
        exists: true,
        changedFiles: 0,
        untrackedFiles: 0,
        ahead: 0,
        behind: 0,
        hasUpstream: false,
        stashEntries: 0,
        message: MESSAGE
      }
    return worktrees.status({ path: request.path, branch: request.branch, baseRef: request.baseRef })
  })
  ipc.handle(WORKTREE_CHANNELS.remove, async (_event, request) => {
    if (
      !isRecord(request) ||
      !isString(request.projectPath) ||
      !isString(request.path) ||
      !isString(request.branch) ||
      !isString(request.baseRef) ||
      (request.force !== undefined && typeof request.force !== 'boolean') ||
      !(await allowed(request.projectPath)) ||
      !(await allowed(request.path))
    )
      return { ...REFUSED, blockers: [{ kind: 'inspection-failed', detail: MESSAGE }] }
    return worktrees.remove({
      projectPath: request.projectPath,
      path: request.path,
      branch: request.branch,
      baseRef: request.baseRef,
      force: request.force
    })
  })
  ipc.handle(WORKTREE_CHANNELS.discover, async (_event, request) => {
    const refused = { worktrees: [], claims: [], message: MESSAGE }
    if (
      !isRecord(request) ||
      !isString(request.projectPath) ||
      !Array.isArray(request.known) ||
      !request.known.every(isString) ||
      !(await allowed(request.projectPath))
    )
      return refused
    for (const path of request.known) if (!(await allowed(path))) return refused
    return worktrees.discover({ projectPath: request.projectPath, known: request.known })
  })
  ipc.handle(WORKTREE_CHANNELS.diff, async (_event, request) => {
    if (!isRecord(request) || !isString(request.path) || !isString(request.baseRef) || !(await allowed(request.path)))
      return { ...REFUSED, reason: 'failed' }
    return worktrees.diff({ path: request.path, baseRef: request.baseRef })
  })
  ipc.handle(WORKTREE_CHANNELS.diffFile, async (_event, request) => {
    if (
      !isRecord(request) ||
      !isString(request.path) ||
      !isString(request.baseRef) ||
      !isDiffFile(request.file) ||
      !(await allowed(request.path))
    )
      return REFUSED
    for (const file of [request.file.path, request.file.oldPath]) {
      if (file === undefined) continue
      const target = resolve(request.path, file)
      const between = relative(request.path, target)
      if (isAbsolute(file) || between.startsWith('..') || isAbsolute(between) || !(await allowed(target)))
        return REFUSED
    }
    return worktrees.diffFile({ path: request.path, baseRef: request.baseRef, file: request.file })
  })
  ipc.handle(WORKTREE_CHANNELS.currentBranch, async (_event, path) =>
    isString(path) && (await allowed(path)) ? worktrees.currentBranch(path) : { isRepository: false }
  )
  ipc.handle(WORKTREE_CHANNELS.listBranches, async (_event, path) =>
    isString(path) && (await allowed(path)) ? worktrees.listBranches(path) : { ...REFUSED, branches: [] }
  )
  ipc.handle(WORKTREE_CHANNELS.checkoutBranch, async (_event, request) => {
    if (!isRecord(request) || !isString(request.path) || !isString(request.branch) || !(await allowed(request.path)))
      return REFUSED
    return worktrees.checkoutBranch({ path: request.path, branch: request.branch })
  })
}
