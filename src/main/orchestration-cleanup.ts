import { existsSync } from 'node:fs'
import type { OrchestrationRecord } from '../shared/orchestration'
import type { TicketCleanupRequest, TicketCleanupResult } from '../shared/orchestration-cleanup'
import { pathIdentity } from '../shared/paths'
import { errorMessage } from '../shared/text'
import { parseWorktreeList } from '../shared/worktree'
import type { GitRunner, WorktreeManager } from './git-worktree'
import type { WorkspaceContainment } from './workspace-containment'

interface CleanupEntry {
  ticket: string
  worktree?: string
  branch?: string
  reason?: string
}

export interface OrchestrationCleanupResult {
  removed: CleanupEntry[]
  retained: CleanupEntry[]
}

export interface OrchestrationCleanup {
  run(record: OrchestrationRecord): Promise<OrchestrationCleanupResult>
}

/** Evidence-gated cleanup: a record's merged flag alone never authorizes deleting a branch. */
export function createOrchestrationCleanup(options: {
  runGit: GitRunner
  worktrees: Pick<WorktreeManager, 'remove'>
  containment: Pick<WorkspaceContainment, 'contains'>
  canvas(request: TicketCleanupRequest): Promise<TicketCleanupResult>
}): OrchestrationCleanup {
  return {
    async run(record) {
      const removed: CleanupEntry[] = []
      const retained: CleanupEntry[] = []
      const git = async (args: string[], cwd = record.projectPath): Promise<string> => {
        const result = await options.runGit(args, cwd)
        if (result.code !== 0) throw new Error(result.stderr.trim() || `git ${args[0]} failed (${result.code})`)
        return result.stdout.trim()
      }
      for (const ticket of record.tickets) {
        const entry = { ticket: ticket.id, worktree: ticket.session?.worktreePath, branch: ticket.session?.branch }
        if (ticket.mergeStatus !== 'merged') {
          retained.push({ ...entry, reason: 'ticket is unmerged' })
          continue
        }
        try {
          const { nodeId, conversationId, worktreePath, branch } = ticket.session ?? {}
          if (!nodeId || !conversationId || !worktreePath || !branch)
            throw new Error('ticket has no complete session identity')
          if (
            !(await options.containment.contains(record.projectPath)) ||
            !(await options.containment.contains(worktreePath))
          ) {
            throw new Error('ticket paths are no longer inside the registered workspace')
          }
          if (!branch.startsWith('ticket/') || branch === record.targetBranch) throw new Error('not a ticket branch')
          const session = { nodeId, conversationId, worktreePath, branch }
          const current = await git(['symbolic-ref', '--quiet', '--short', 'HEAD'])
          if (current !== record.targetBranch)
            throw new Error('the orchestrator checkout is no longer on the target branch')
          const listed = parseWorktreeList(await git(['worktree', 'list', '--porcelain']))
          const worktree = listed.find((item) => pathIdentity(item.path) === pathIdentity(worktreePath))
          if (worktree && (worktree.isMain || worktree.branch !== branch)) throw new Error('worktree identity changed')
          if (!worktree && existsSync(worktreePath))
            throw new Error('the path is no longer a registered ticket worktree')
          const ref = `refs/heads/${branch}`
          const refs = await git(['for-each-ref', '--format=%(refname)', ref])
          const hasBranch = refs.split(/\r?\n/).includes(ref)
          if (hasBranch) {
            const head = await git(['rev-parse', '--verify', ref])
            const target = await git(['rev-parse', '--verify', `refs/heads/${record.targetBranch}`])
            const upstream = await git(['rev-parse', '--verify', `${record.targetBranch}@{upstream}`])
            await git(['merge-base', '--is-ancestor', head, target])
            await git(['merge-base', '--is-ancestor', head, upstream])
          } else if (worktree) throw new Error('the ticket branch is missing')
          if (worktree) {
            // Read failures are blockers too. The general worktree status API tolerates a failed
            // stash read for display; deletion here needs positive evidence instead.
            if (await git(['stash', 'list', '--format=%gs'], worktreePath))
              throw new Error('repository has stashed work')
            if (await git(['status', '--porcelain', '--untracked-files=all'], worktreePath))
              throw new Error('worktree has uncommitted or untracked work')
            const closed = await options.canvas({ projectPath: record.projectPath, session, phase: 'close' })
            if (!closed.ok) throw new Error(closed.message)
            const result = await options.worktrees.remove({
              projectPath: record.projectPath,
              path: worktreePath,
              branch,
              baseRef: record.targetBranch
            })
            if (!result.ok) throw new Error(result.message || result.blockers.map((blocker) => blocker.kind).join(', '))
          }
          // -d rechecks reachability at deletion time; never force past Git's verdict.
          if (hasBranch) await git(['branch', '-d', '--', branch])
          const retired = await options.canvas({ projectPath: record.projectPath, session, phase: 'remove' })
          if (!retired.ok) throw new Error(`Git cleanup finished; canvas cleanup failed: ${retired.message}`)
          removed.push(entry)
        } catch (error) {
          retained.push({ ...entry, reason: errorMessage(error) })
        }
      }
      return { removed, retained }
    }
  }
}
