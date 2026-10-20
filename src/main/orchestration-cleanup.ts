import { existsSync } from 'node:fs'
import { isTicketSettled, type OrchestrationRecord, type OrchestrationTicket } from '../shared/orchestration'
import type { TicketCleanupRequest, TicketCleanupResult } from '../shared/orchestration-cleanup'
import { pathIdentity } from '../shared/paths'
import { errorMessage } from '../shared/text'
import { parseWorktreeList } from '../shared/worktree'
import type { GitRunner, WorktreeManager } from './git-worktree'
import type { WorkspaceContainment } from './workspace-containment'
import { describeRemovalFailure, inspectLeftover, removeTree } from './worktree-leftover'

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
  /** A ticket id retires one freshly settled session; absent performs the final full sweep. */
  run(record: OrchestrationRecord, ticketId?: string): Promise<OrchestrationCleanupResult>
  /**
   * Why a ticket may not be recorded `answered`, or undefined when Git shows it is: its worktree is
   * clean and its branch holds no commit the target lacks.
   */
  answeredRefusal(record: OrchestrationRecord, ticket: OrchestrationTicket): Promise<string | undefined>
}

/** Evidence-gated cleanup: a record's merged or answered flag alone never authorizes deleting a branch. */
export function createOrchestrationCleanup(options: {
  runGit: GitRunner
  worktrees: Pick<WorktreeManager, 'remove'>
  containment: Pick<WorkspaceContainment, 'contains'>
  canvas(request: TicketCleanupRequest): Promise<TicketCleanupResult>
}): OrchestrationCleanup {
  const gitIn =
    (record: OrchestrationRecord) =>
    async (args: string[], cwd = record.projectPath): Promise<string> => {
      const result = await options.runGit(args, cwd)
      if (result.code !== 0) throw new Error(result.stderr.trim() || `git ${args[0]} failed (${result.code})`)
      return result.stdout.trim()
    }
  return {
    async answeredRefusal(record, ticket) {
      const git = gitIn(record)
      const { worktreePath, branch } = ticket.session ?? {}
      if (!worktreePath || !branch) return `ticket ${ticket.id} has no ticket session to have answered it`
      try {
        if (!(await options.containment.contains(worktreePath)))
          return 'the ticket worktree is no longer inside the registered workspace'
        if (await git(['status', '--porcelain', '--untracked-files=all'], worktreePath))
          return `ticket ${ticket.id}'s worktree has uncommitted or untracked work; merge it or have the session discard it`
        const ahead = await git(['rev-list', '--count', `refs/heads/${record.targetBranch}..refs/heads/${branch}`])
        if (ahead !== '0')
          return `ticket ${ticket.id}'s branch has ${ahead} commit(s) the target lacks; merge it instead`
        return undefined
      } catch (error) {
        return `could not verify ticket ${ticket.id} as answered: ${errorMessage(error)}`
      }
    },
    async run(record, ticketId) {
      const removed: CleanupEntry[] = []
      const retained: CleanupEntry[] = []
      const git = gitIn(record)
      const tickets =
        ticketId === undefined ? record.tickets : record.tickets.filter((ticket) => ticket.id === ticketId)
      for (const ticket of tickets) {
        const entry = { ticket: ticket.id, worktree: ticket.session?.worktreePath, branch: ticket.session?.branch }
        if (!isTicketSettled(ticket.mergeStatus)) {
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
          // A recorded folder git no longer lists is what a half-failed `worktree remove` leaves;
          // it is finished below once its contents are proved to be nothing but published files.
          const leftover = !worktree && existsSync(worktreePath)
          const ref = `refs/heads/${branch}`
          const refs = await git(['for-each-ref', '--format=%(refname)', ref])
          const hasBranch = refs.split(/\r?\n/).includes(ref)
          const published: string[] = []
          if (hasBranch) {
            const head = await git(['rev-parse', '--verify', ref])
            const target = await git(['rev-parse', '--verify', `refs/heads/${record.targetBranch}`])
            const upstream = await git(['rev-parse', '--verify', `${record.targetBranch}@{upstream}`])
            await git(['merge-base', '--is-ancestor', head, target])
            await git(['merge-base', '--is-ancestor', head, upstream])
            published.push(head, upstream)
          } else if (worktree) throw new Error('the ticket branch is missing')
          // An earlier sweep already deleted the proved branch; the published target is what is left.
          else if (leftover) published.push(await git(['rev-parse', '--verify', `${record.targetBranch}@{upstream}`]))

          // Publication is the terminal point for the agent process. Retire it before checking
          // filesystem blockers so a dirty tree or another canvas occupant retains evidence, not RAM.
          const retired = await options.canvas({ projectPath: record.projectPath, session, phase: 'retire' })
          if (!retired.ok) throw new Error(retired.message)
          if (worktree) {
            if (await git(['status', '--porcelain', '--untracked-files=all'], worktreePath))
              throw new Error('worktree has uncommitted or untracked work')
          }
          if (leftover) {
            const findings = await inspectLeftover({
              runGit: options.runGit,
              projectPath: record.projectPath,
              folder: worktreePath,
              refs: published
            })
            if (findings.length > 0)
              throw new Error(`the unregistered worktree folder still holds work: ${findings.join('; ')}`)
          }
          const prepared = await options.canvas({ projectPath: record.projectPath, session, phase: 'prepare' })
          if (!prepared.ok) throw new Error(prepared.message)
          // A refusal (a blocker) keeps everything; a removal that ran and failed costs only the
          // folder, because the branch's publication is already proved.
          let folderFailure: string | undefined
          if (worktree) {
            const result = await options.worktrees.remove({
              projectPath: record.projectPath,
              path: worktreePath,
              branch,
              baseRef: record.targetBranch
            })
            if (!result.ok && result.blockers.length > 0)
              throw new Error(result.message || result.blockers.map((blocker) => blocker.kind).join(', '))
            if (!result.ok) folderFailure = result.message || 'git worktree remove failed'
          } else if (leftover) {
            try {
              await removeTree(worktreePath)
            } catch (error) {
              folderFailure = await describeRemovalFailure(worktreePath, errorMessage(error))
            }
          }
          // -d rechecks reachability at deletion time; never force past Git's verdict.
          if (hasBranch) {
            try {
              await git(['branch', '-d', '--', branch])
            } catch (error) {
              if (!folderFailure) throw error
              throw new Error(
                `worktree folder retained: ${folderFailure}; branch not deleted: ${errorMessage(error)}`,
                {
                  cause: error
                }
              )
            }
          }
          if (folderFailure)
            throw new Error(
              `${hasBranch ? `branch ${branch} deleted; ` : ''}worktree folder retained: ${folderFailure}`
            )
          const removedFromCanvas = await options.canvas({ projectPath: record.projectPath, session, phase: 'remove' })
          if (!removedFromCanvas.ok)
            throw new Error(`Git cleanup finished; canvas cleanup failed: ${removedFromCanvas.message}`)
          removed.push(entry)
        } catch (error) {
          retained.push({ ...entry, reason: errorMessage(error) })
        }
      }
      return { removed, retained }
    }
  }
}
