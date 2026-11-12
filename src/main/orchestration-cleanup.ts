import { existsSync } from 'node:fs'
import {
  isTicketSettled,
  ticketBranchBelongsTo,
  ticketBranchTail,
  ticketIdOfBranch,
  type OrchestrationRecord,
  type OrchestrationTicket
} from '../shared/orchestration'
import type {
  LiveSessionLocation,
  TicketCleanupRequest,
  TicketCleanupResult,
  UnrecordedAttempt
} from '../shared/orchestration-cleanup'
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
  /**
   * The ticket worktrees and `ticket/*` branches Git holds that the record has no attempt for, plus
   * those a live session works in that the record does not name. Read-only.
   */
  unrecorded(record: OrchestrationRecord): Promise<UnrecordedAttempt[]>
  /**
   * Throws an attempt away (#4): removes its worktree even with uncommitted or unpublished work,
   * force-deletes its branch, and clears its canvas frame. The caller has stopped the session.
   * Refuses only what is not a ticket worktree/branch of this project; never touches the target.
   */
  discard(record: OrchestrationRecord, target: DiscardTarget): Promise<DiscardResult>
}

export interface DiscardTarget {
  ticket: string
  branch: string
  worktreePath?: string
  nodeId?: string
  conversationId?: string
}

export type DiscardResult =
  { ok: true; removedWorktree: boolean; deletedBranch: boolean; ahead: number | null } | { ok: false; error: string }

/** Why a sweep keeps an unrecorded attempt instead of judging it. */
export const UNRECORDED_ATTEMPT_REASON = 'unrecorded attempt'

/** How long a folder a process still holds gets to be let go: about 21 minutes in all. */
export const FOLDER_RETRY_DELAYS_MS: readonly number[] = [15_000, 60_000, 5 * 60_000, 15 * 60_000]

/** Evidence-gated cleanup: a record's merged or answered flag alone never authorizes deleting a branch. */
export function createOrchestrationCleanup(options: {
  runGit: GitRunner
  worktrees: Pick<WorktreeManager, 'remove'>
  containment: Pick<WorkspaceContainment, 'contains'>
  canvas(request: TicketCleanupRequest): Promise<TicketCleanupResult>
  /**
   * Cleans a ticket again after only its folder could not be deleted. A process still holds such
   * a folder - typically a tool shell or an install the retired session started, which outlives
   * the agent - and lets go when it exits. One attempt per delay, `FOLDER_RETRY_DELAYS_MS` unless
   * given; absent, a later sweep is the retry.
   */
  folderRetry?: { schedule(retry: () => Promise<void>, ms: number): void; delaysMs?: readonly number[] }
  /** The live agent sessions and where they run; absent, no unrecorded attempt reads as live. */
  liveSessions?(): LiveSessionLocation[]
  log?(message: string): void
}): OrchestrationCleanup {
  const gitIn =
    (record: OrchestrationRecord) =>
    async (args: string[], cwd = record.projectPath): Promise<string> => {
      const result = await options.runGit(args, cwd)
      if (result.code !== 0) throw new Error(result.stderr.trim() || `git ${args[0]} failed (${result.code})`)
      return result.stdout.trim()
    }
  /** Worktree folders with a retry waiting, so a sweep in the meantime does not stack a second. */
  const pendingRetries = new Set<string>()
  /** Whether a retry of this ticket's cleanup is waiting; the whole evidence gate runs again. */
  const scheduleFolderRetry = (
    record: OrchestrationRecord,
    ticketId: string,
    worktreePath: string,
    attempt: number
  ): boolean => {
    const key = pathIdentity(worktreePath)
    if (pendingRetries.has(key)) return true
    const delays = options.folderRetry?.delaysMs ?? FOLDER_RETRY_DELAYS_MS
    if (!options.folderRetry || attempt >= delays.length) return false
    pendingRetries.add(key)
    options.folderRetry.schedule(async () => {
      pendingRetries.delete(key)
      try {
        const result = await sweep(record, ticketId, attempt)
        const reason = result.retained[0]?.reason
        options.log?.(
          reason === undefined
            ? `ticket ${ticketId}: retained worktree folder deleted on retry`
            : `ticket ${ticketId}: worktree folder retry ${attempt + 1} retained it: ${reason}`
        )
      } catch (error) {
        options.log?.(`ticket ${ticketId}: worktree folder retry failed: ${errorMessage(error)}`)
      }
    }, delays[attempt])
    return true
  }

  const unrecorded = async (record: OrchestrationRecord): Promise<UnrecordedAttempt[]> => {
    const git = gitIn(record)
    // Every attempt the record holds counts, not only each ticket's latest session; a discarded
    // one is gone from Git, and one that somehow survives is exactly what should be reported.
    const sessions = record.tickets.flatMap((ticket) => [
      ...(ticket.session ? [ticket.session] : []),
      ...(ticket.runs ?? []).filter((run) => !run.discarded)
    ])
    const recordedPaths = new Set(sessions.flatMap((s) => (s.worktreePath ? [pathIdentity(s.worktreePath)] : [])))
    const recordedBranches = new Set(sessions.flatMap((s) => (s.branch ? [s.branch] : [])))
    const recordedNodes = new Set(sessions.flatMap((s) => (s.nodeId ? [s.nodeId] : [])))
    const live = options.liveSessions?.() ?? []
    const liveIn = (path: string) => live.filter((session) => pathIdentity(session.cwd) === pathIdentity(path))
    const ahead = async (branch: string): Promise<number | null> => {
      try {
        return Number(await git(['rev-list', '--count', `refs/heads/${record.targetBranch}..refs/heads/${branch}`]))
      } catch {
        return null
      }
    }
    const attempt = async (branch: string, path?: string): Promise<UnrecordedAttempt> => {
      const sessionsHere = path ? liveIn(path) : []
      const unnamed = sessionsHere.find((session) => !recordedNodes.has(session.nodeId)) ?? sessionsHere[0]
      return {
        ticket: ticketIdOfBranch(record, branch) ?? ticketBranchTail(branch),
        ...(path ? { path } : {}),
        branch,
        ahead: await ahead(branch),
        liveSession: sessionsHere.length > 0,
        ...(unnamed ? { nodeId: unnamed.nodeId } : {}),
        ...(unnamed?.conversationId ? { conversationId: unnamed.conversationId } : {})
      }
    }

    // Another orchestration's ticket branches are its own business, never this one's to report.
    const ownBranch = (branch: string) => branch !== record.targetBranch && ticketBranchBelongsTo(record, branch)
    const found: UnrecordedAttempt[] = []
    const seen = new Set<string>()
    const registered = parseWorktreeList(await git(['worktree', 'list', '--porcelain']))
    for (const item of registered) {
      if (item.isMain || !ownBranch(item.branch)) continue
      seen.add(item.branch)
      const unnamedSession = liveIn(item.path).some((session) => !recordedNodes.has(session.nodeId))
      const recorded = recordedPaths.has(pathIdentity(item.path)) || recordedBranches.has(item.branch)
      if (!recorded || unnamedSession) found.push(await attempt(item.branch, item.path))
    }
    const heads = await git(['for-each-ref', '--format=%(refname:short)', 'refs/heads/ticket/'])
    for (const branch of heads.split(/\r?\n/).filter(Boolean)) {
      if (seen.has(branch) || !ownBranch(branch) || recordedBranches.has(branch)) continue
      found.push(await attempt(branch))
    }
    return found
  }

  /** `retry` is the index of the folder retry this sweep is; a sweep anyone asked for has none. */
  const sweep = async (
    record: OrchestrationRecord,
    ticketId: string | undefined,
    retry?: number
  ): Promise<OrchestrationCleanupResult> => {
    const removed: CleanupEntry[] = []
    const retained: CleanupEntry[] = []
    const git = gitIn(record)
    const tickets = ticketId === undefined ? record.tickets : record.tickets.filter((ticket) => ticket.id === ticketId)
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
        const registration = async () =>
          parseWorktreeList(await git(['worktree', 'list', '--porcelain'])).find(
            (item) => pathIdentity(item.path) === pathIdentity(worktreePath)
          )
        let worktree = await registration()
        // A checkout deleted behind Git's back stays registered, its branch checked out, until a
        // prune - which drops only registrations whose checkout is gone, so it costs no work.
        if (worktree?.prunable) {
          await git(['worktree', 'prune'])
          worktree = await registration()
        }
        if (worktree && (worktree.isMain || worktree.branch !== branch)) throw new Error('worktree identity changed')
        // A recorded folder git no longer lists is what a half-failed `worktree remove` leaves;
        // it is finished below once its contents are proved to be nothing but published files.
        const leftover = !worktree && existsSync(worktreePath)
        const ref = `refs/heads/${branch}`
        const refs = await git(['for-each-ref', '--format=%(refname)', ref])
        const hasBranch = refs.split(/\r?\n/).includes(ref)
        // A retry only ever finishes a leftover; a registered worktree or branch of the ticket's
        // name is a later spawn reusing it, which the retry's captured record knows nothing about.
        if (retry !== undefined && (worktree || hasBranch))
          throw new Error('the ticket worktree or branch exists again; the folder retry stopped')
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
            throw new Error(`worktree folder retained: ${folderFailure}; branch not deleted: ${errorMessage(error)}`, {
              cause: error
            })
          }
        }
        // Past `-d` the branch is gone - it refuses one any registered worktree has checked out - or
        // never existed, so Git no longer registers the folder, and the clean status or the leftover
        // inspection proved nothing in it unpublished. A folder that alone survived, held open by
        // some process, leaves the ticket chat and its canvas group nothing to guard.
        const removedFromCanvas = await options.canvas({ projectPath: record.projectPath, session, phase: 'remove' })
        if (folderFailure) {
          const retrying = scheduleFolderRetry(record, ticket.id, worktreePath, retry === undefined ? 0 : retry + 1)
          throw new Error(
            [
              hasBranch && `branch ${branch} deleted`,
              removedFromCanvas.ok && 'ticket chat and canvas group removed',
              `worktree folder retained: ${folderFailure}`,
              !removedFromCanvas.ok && `canvas cleanup failed: ${removedFromCanvas.message}`,
              retrying && 'Toucan retries deleting it'
            ]
              .filter(Boolean)
              .join('; ')
          )
        }
        if (!removedFromCanvas.ok)
          throw new Error(`Git cleanup finished; canvas cleanup failed: ${removedFromCanvas.message}`)
        removed.push(entry)
      } catch (error) {
        retained.push({ ...entry, reason: errorMessage(error) })
      }
    }
    // A folder retry only finishes one ticket's leftover; what the record lacks is for a sweep to name.
    if (retry === undefined) {
      try {
        for (const attempt of await unrecorded(record)) {
          if (ticketId !== undefined && attempt.ticket !== ticketId) continue
          retained.push({
            ticket: attempt.ticket,
            worktree: attempt.path,
            branch: attempt.branch,
            reason: UNRECORDED_ATTEMPT_REASON
          })
        }
      } catch (error) {
        options.log?.(`could not look for unrecorded ticket worktrees: ${errorMessage(error)}`)
      }
    }
    return { removed, retained }
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
    unrecorded,
    async discard(record, target) {
      const git = gitIn(record)
      const { branch, worktreePath } = target
      try {
        if (!branch.startsWith('ticket/') || branch === record.targetBranch) {
          return { ok: false, error: `${branch} is not a ticket branch` }
        }
        if (!ticketBranchBelongsTo(record, branch)) {
          return { ok: false, error: `${branch} is not a ticket branch of this orchestration` }
        }
        if (!(await options.containment.contains(record.projectPath))) {
          return { ok: false, error: 'the project is no longer inside the registered workspace' }
        }
        if (worktreePath && !(await options.containment.contains(worktreePath))) {
          return { ok: false, error: 'the worktree is no longer inside the registered workspace' }
        }
        const ref = `refs/heads/${branch}`
        const hasBranch = (await git(['for-each-ref', '--format=%(refname)', ref])).split(/\r?\n/).includes(ref)
        let ahead: number | null = null
        if (hasBranch) {
          try {
            ahead = Number(await git(['rev-list', '--count', `refs/heads/${record.targetBranch}..${ref}`]))
          } catch {
            ahead = null
          }
        }
        const registration = async () =>
          worktreePath
            ? parseWorktreeList(await git(['worktree', 'list', '--porcelain'])).find(
                (item) => pathIdentity(item.path) === pathIdentity(worktreePath)
              )
            : undefined
        let worktree = await registration()
        if (worktree?.prunable) {
          await git(['worktree', 'prune'])
          worktree = await registration()
        }
        if (worktree && (worktree.isMain || worktree.branch !== branch)) {
          return { ok: false, error: `${worktreePath} is not the worktree of ${branch}` }
        }
        const session =
          worktreePath && target.nodeId
            ? {
                nodeId: target.nodeId,
                worktreePath,
                branch,
                ...(target.conversationId ? { conversationId: target.conversationId } : {})
              }
            : undefined
        if (session) {
          const prepared = await options.canvas({ projectPath: record.projectPath, session, phase: 'prepare' })
          if (!prepared.ok) return { ok: false, error: prepared.message }
        }
        let removedWorktree = false
        if (worktreePath && worktree) {
          const result = await options.worktrees.remove({
            projectPath: record.projectPath,
            path: worktreePath,
            branch,
            baseRef: record.targetBranch,
            force: true
          })
          if (!result.ok) {
            return {
              ok: false,
              error:
                result.message || result.blockers.map((blocker) => blocker.kind).join(', ') || 'worktree removal failed'
            }
          }
          removedWorktree = true
        } else if (worktreePath && existsSync(worktreePath)) {
          // Git no longer lists the folder (a half-failed removal, or one deleted by hand).
          await removeTree(worktreePath)
          removedWorktree = true
        }
        let deletedBranch = false
        if (hasBranch) {
          await git(['branch', '-D', '--', branch])
          deletedBranch = true
        }
        if (session) {
          const removed = await options.canvas({ projectPath: record.projectPath, session, phase: 'remove' })
          if (!removed.ok) options.log?.(`discard of ${branch}: canvas cleanup failed: ${removed.message}`)
        }
        return { ok: true, removedWorktree, deletedBranch, ahead }
      } catch (error) {
        return { ok: false, error: errorMessage(error) }
      }
    },
    run: (record, ticketId) => sweep(record, ticketId)
  }
}
