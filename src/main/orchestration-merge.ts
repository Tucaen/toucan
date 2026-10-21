import type { OrchestrationRecord, OrchestrationTicket } from '../shared/orchestration'
import { pathIdentity } from '../shared/paths'
import { errorMessage } from '../shared/text'
import type { GitRunner } from './git-worktree'
import type { WorkspaceContainment } from './workspace-containment'

/**
 * Where a refused merge stopped: `check` changed nothing; `merge` means the fast-forward itself
 * failed; `push` means the target checkout holds the merge but its upstream does not.
 */
export type OrchestrationMergeStage = 'check' | 'merge' | 'push'

export type OrchestrationMergeResult =
  | { ok: true; commit: string; upstream: string }
  | { ok: false; stage: OrchestrationMergeStage; error: string; rejected?: boolean }

export interface OrchestrationMerge {
  /**
   * Fast-forwards the target checkout to the ticket branch and pushes it, only once Git shows the
   * branch's HEAD is the commit the orchestrator says passed the suite and already contains the
   * target. The record's own rules (merge status, blockers, a settled session) are the caller's.
   */
  run(record: OrchestrationRecord, ticket: OrchestrationTicket, tested: string): Promise<OrchestrationMergeResult>
}

class Refusal extends Error {
  constructor(
    readonly stage: OrchestrationMergeStage,
    message: string,
    readonly rejected?: boolean
  ) {
    super(message)
  }
}

/** Git's words for a push the remote refused because it moved on, as opposed to auth or network. */
const REJECTED_PUSH = /\[rejected\]|non-fast-forward|fetch first/

/**
 * Toucan runs the merge rather than the orchestrator's shell, where a push to the target could sit
 * behind the agent's own permission check and look merely pending. Never forces, never creates a merge commit,
 * and pushes only the recorded target to the upstream its checkout already tracks.
 */
export function createOrchestrationMerge(options: {
  runGit: GitRunner
  containment: Pick<WorkspaceContainment, 'contains'>
}): OrchestrationMerge {
  // Serial per checkout: two merges racing in one working tree would each pass the other's checks.
  const queues = new Map<string, Promise<unknown>>()

  const merge = async (
    record: OrchestrationRecord,
    ticket: OrchestrationTicket,
    tested: string
  ): Promise<OrchestrationMergeResult> => {
    const git = async (args: string[], cwd = record.projectPath, stage: OrchestrationMergeStage = 'check') => {
      const result = await options.runGit(args, cwd)
      if (result.code !== 0) throw new Refusal(stage, result.stderr.trim() || `git ${args[0]} failed (${result.code})`)
      return result.stdout.trim()
    }
    const probe = async (args: string[], cwd = record.projectPath) => (await options.runGit(args, cwd)).code === 0
    try {
      const { worktreePath, branch } = ticket.session ?? {}
      if (!worktreePath || !branch) throw new Refusal('check', `ticket ${ticket.id} has no ticket session to merge`)
      if (!branch.startsWith('ticket/') || branch === record.targetBranch)
        throw new Refusal('check', `${branch} is not a ticket branch`)
      if (
        !(await options.containment.contains(record.projectPath)) ||
        !(await options.containment.contains(worktreePath))
      ) {
        throw new Refusal('check', 'the ticket paths are no longer inside the registered workspace')
      }
      const target = record.targetBranch
      if ((await git(['symbolic-ref', '--quiet', '--short', 'HEAD'])) !== target)
        throw new Refusal('check', `the target checkout is not on ${target}`)
      if (await git(['status', '--porcelain', '--untracked-files=all']))
        throw new Refusal('check', 'the target checkout has uncommitted or untracked work')
      if (await git(['status', '--porcelain', '--untracked-files=all'], worktreePath))
        throw new Refusal('check', `ticket ${ticket.id}'s worktree has uncommitted or untracked work`)
      const head = await git(['rev-parse', '--verify', `refs/heads/${branch}^{commit}`])
      const testedCommit = await git(['rev-parse', '--verify', `${tested}^{commit}`]).catch(() => {
        throw new Refusal('check', `the tested commit ${tested} is not a commit in this repository`)
      })
      if (testedCommit !== head)
        throw new Refusal(
          'check',
          `the tested commit ${testedCommit} is not ${branch}'s HEAD ${head}; have the session run the full suite on its HEAD`
        )
      if (!(await probe(['merge-base', '--is-ancestor', `refs/heads/${target}`, head])))
        throw new Refusal(
          'check',
          `${branch} does not contain the ${target} tip; have the session rebase onto ${target} and run the full suite again`
        )
      const remote = await git(['config', '--get', `branch.${target}.remote`]).catch(() => '')
      const remoteRef = await git(['config', '--get', `branch.${target}.merge`]).catch(() => '')
      if (!remote || !remoteRef || remote === '.')
        throw new Refusal('check', `${target} has no upstream on a remote; set it with git push -u before merging`)
      const upstream = `${remote}/${remoteRef.replace(/^refs\/heads\//, '')}`

      await git(['merge', '--ff-only', head], record.projectPath, 'merge')
      if ((await git(['rev-parse', '--verify', `refs/heads/${target}`], record.projectPath, 'merge')) !== head)
        throw new Refusal('merge', `${target} did not move to ${head}`)

      const pushed = await options.runGit(['push', remote, `refs/heads/${target}:${remoteRef}`], record.projectPath)
      if (pushed.code !== 0) {
        const detail = pushed.stderr.trim() || `git push failed (${pushed.code})`
        const rejected = REJECTED_PUSH.test(detail)
        throw new Refusal(
          'push',
          `${target} now holds ${head} locally but ${upstream} refused it: ${detail}` +
            (rejected ? '. The upstream moved on; follow the push-rejected recovery' : ''),
          rejected
        )
      }
      return { ok: true, commit: head, upstream }
    } catch (error) {
      if (error instanceof Refusal)
        return { ok: false, stage: error.stage, error: error.message, ...(error.rejected ? { rejected: true } : {}) }
      return { ok: false, stage: 'check', error: `could not merge ticket ${ticket.id}: ${errorMessage(error)}` }
    }
  }

  return {
    run(record, ticket, tested) {
      const key = pathIdentity(record.projectPath)
      const queued = (queues.get(key) ?? Promise.resolve()).then(() => merge(record, ticket, tested))
      const settled = queued.catch(() => undefined)
      queues.set(key, settled)
      void settled.then(() => {
        if (queues.get(key) === settled) queues.delete(key)
      })
      return queued
    }
  }
}
