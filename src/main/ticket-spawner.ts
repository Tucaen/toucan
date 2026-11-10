import {
  ticketBranchCandidates,
  ticketSessionPrompt,
  ticketSessionTitle,
  type OrchestrationTicket,
  type TicketSession
} from '../shared/orchestration'
import { errorMessage } from '../shared/text'
import {
  orchestratorProvider,
  type OrchestratorLink,
  type TicketSessionCanvasRequest,
  type TicketSessionCanvasResult,
  type TicketSessionProgress
} from '../shared/ticket-session-spawn'
import type { AgentProvider } from '../shared/agent-provider'
import type { GitRunner, WorktreeManager } from './git-worktree'
import type { ScratchDirectoryResult } from './scratch-directory'
import type { PushGuardResult } from './ticket-push-guard'
import type { TicketSessionObserver } from './ticket-session-requests'

/**
 * What the orchestrator endpoint asks for once a `spawn` is authorized and counted (#34; plan in
 * `docs/plans/orchestrator-mode.md`): one ticket session in a worktree Toucan creates for it.
 */
export interface TicketSpawnRequest {
  /** The orchestrator the session is linked to by its orchestrated-by edge. */
  orchestrator: OrchestratorLink
  /** The orchestrator's project checkout; the worktree is created from it. */
  projectPath: string
  /** The branch the orchestration merges into; the ticket branch starts from it. */
  targetBranch: string
  ticket: OrchestrationTicket
  model: string
  effort: string
  /** What the prompt opens with (#36); the default skill when absent. */
  implementationSkill?: string
  /** How long to wait for the session to show life before answering `pending`; the default when absent. */
  startTimeoutMs?: number
  /**
   * The canvas holds the session's node and it is not up yet (#1), and again once it has a
   * conversation id: the caller records it against the ticket now, so a start that outlasts the
   * wait - or never finishes - leaves a linked session rather than an invisible one.
   */
  onSession?(session: LinkedTicketSession): Promise<void> | void
  /** How a spawn that answered `pending` settled, once it has. */
  onSettled?(outcome: TicketSpawnSettlement): void
}

/** A ticket session as far as is known: the conversation comes with the session's first output. */
export type LinkedTicketSession = Omit<Required<TicketSession>, 'conversationId'> & { conversationId?: string }

/** A spawn's final verdict: what a result says once it is not `pending`. */
export type TicketSpawnSettlement =
  | {
      ok: true
      session: Required<TicketSession>
      /** The model and effort the running session reports, read back rather than assumed. */
      model?: string
      effort?: string
      /** What the caller should know but that did not stop the spawn. */
      warnings: string[]
    }
  | { ok: false; error: string }

export type TicketSpawnResult =
  | TicketSpawnSettlement
  | {
      ok: false
      /** The session did not show life in time but is neither failed nor closed; `onSettled` follows. */
      pending: true
      session: LinkedTicketSession
      error: string
    }

export interface TicketSpawner {
  /** Never rejects: every failure is `{ ok: false }` with the reason the CLI prints. */
  spawn(request: TicketSpawnRequest): Promise<TicketSpawnResult>
}

/** What the spawner reads of a live session: the ticket session's model and effort. */
export interface SessionSettings {
  model?: string
  effort?: string
}

export interface TicketSpawnerOptions {
  worktrees: Pick<WorktreeManager, 'create'>
  /** Runs git for the one clean-up the spawner does itself: discarding a worktree it just made. */
  runGit: GitRunner
  installGuard(worktreePath: string): Promise<PushGuardResult>
  /** The workspace project behind a checkout path, with its setup command. */
  project(projectPath: string): Promise<{ id: string; setupCommand?: string } | undefined>
  runSetup(command: string, cwd: string): Promise<{ ok: true } | { ok: false; error: string }>
  canvas: {
    startTicketSession(
      request: TicketSessionCanvasRequest,
      observer?: TicketSessionObserver
    ): Promise<TicketSessionCanvasResult>
    /** Toucan treats this node's start as failed: its session is stopped, not only left in its worktree. */
    cancelTicketSession?(nodeId: string): void
  }
  /** A live session's settings by node id, from the event broker's snapshot. */
  session(nodeId: string): SessionSettings | undefined
  /** The provider's picker catalogue; empty until a session advertises it. */
  offeredModels(provider: AgentProvider): readonly string[]
  offeredEfforts(provider: AgentProvider, modelId: string): readonly string[] | undefined
  /** A worktree main created, so the chat launching in it is not refused as outside the workspace. */
  onWorktreeCreated(path: string): void
  /**
   * The project's scratch folder in its main checkout (#3), ready for files meant for the human.
   * Absent, or failing, the session simply is not told about one; it never stops the spawn.
   */
  scratchDirectory?(projectPath: string): Promise<ScratchDirectoryResult>
}

/**
 * Creates the worktree, guards it, sets it up, and only then asks the canvas for the chat - so a
 * ticket session never starts in a checkout that can push or that is missing its dependencies. A
 * project without a setup command has nothing to install them with, so that spawn says so in its
 * warnings instead of starting the chat as if the worktree were ready. A worktree that fails
 * before the canvas has seen it is removed again with its branch: both are seconds old and hold
 * nothing but the target branch's commits. One the canvas has registered stays, because from then
 * on it is a canvas entity the human can see and remove.
 */
export function createTicketSpawner(options: TicketSpawnerOptions): TicketSpawner {
  /** Removes a worktree only this spawn has seen; says what is left behind when git refuses. */
  const discard = async (projectPath: string, path: string, branch: string): Promise<string> => {
    const removed = await options.runGit(['worktree', 'remove', '--force', path], projectPath)
    if (removed.code !== 0) return ` The worktree could not be removed and stays at ${path} on ${branch}.`
    const deleted = await options.runGit(['branch', '-D', branch], projectPath)
    return deleted.code === 0 ? '' : ` Its branch ${branch} could not be deleted.`
  }

  const createWorktree = async (
    request: TicketSpawnRequest
  ): Promise<{ path: string; branch: string; baseRef: string } | { error: string }> => {
    // The names never run out, so this ends at the first free one or a failure that is no conflict.
    for (const branch of ticketBranchCandidates(request.ticket.id)) {
      const created = await options.worktrees.create({
        projectPath: request.projectPath,
        branch,
        baseRef: request.targetBranch
      })
      if (created.ok && created.worktree) return created.worktree
      if (!created.conflict) return { error: `the worktree could not be created: ${created.message ?? 'git failed'}` }
    }
    throw new Error('unreachable: ticket branch names are endless')
  }

  const spawn = async (request: TicketSpawnRequest): Promise<TicketSpawnResult> => {
    const project = await options.project(request.projectPath)
    if (!project) return { ok: false, error: `the project ${request.projectPath} is not open in Toucan` }
    const provider = orchestratorProvider(request.orchestrator)
    const offered = options.offeredModels(provider)
    if (offered.length > 0 && !offered.includes(request.model)) {
      return { ok: false, error: `model "${request.model}" is not offered; the picker offers ${offered.join(', ')}` }
    }
    const efforts = options.offeredEfforts(provider, request.model)
    if (efforts && efforts.length > 0 && !efforts.includes(request.effort)) {
      return {
        ok: false,
        error: `effort "${request.effort}" is not offered for "${request.model}"; the picker offers ${efforts.join(', ')}`
      }
    }
    const worktree = await createWorktree(request)
    if ('error' in worktree) return { ok: false, error: worktree.error }
    options.onWorktreeCreated(worktree.path)

    const guarded = await options.installGuard(worktree.path)
    if (!guarded.ok) {
      const left = await discard(request.projectPath, worktree.path, worktree.branch)
      return { ok: false, error: `${guarded.error}${left}` }
    }
    const warnings: string[] = []
    const setupCommand = project.setupCommand?.trim()
    if (!setupCommand) {
      warnings.push(
        `the project has no setup command, so nothing was installed in ${worktree.path}; ` +
          "set its Setup command in the project's settings in Toucan, or install dependencies in the session"
      )
    } else {
      const setup = await options.runSetup(setupCommand, worktree.path)
      if (!setup.ok) {
        const left = await discard(request.projectPath, worktree.path, worktree.branch)
        return {
          ok: false,
          error: `the setup command failed: ${setup.error}${left || ' The worktree was removed again.'}`
        }
      }
    }

    // The main checkout's folder, not the worktree's: the worktree is removed after the merge.
    let scratchPath: string | undefined
    if (options.scratchDirectory) {
      const scratch = await options.scratchDirectory(request.projectPath)
      if (scratch.ok) scratchPath = scratch.path
      else warnings.push(`${scratch.error}; the session was not told where to save files for you`)
    }

    const canvasRequest: TicketSessionCanvasRequest = {
      provider,
      projectId: project.id,
      worktree,
      label: ticketSessionTitle(request.ticket),
      modelId: request.model,
      effortId: request.effort,
      orchestratedBy: { ...request.orchestrator, provider },
      prompt: ticketSessionPrompt(request.ticket, worktree, request.implementationSkill, scratchPath)
    }
    const linked = (progress: TicketSessionProgress): LinkedTicketSession => ({
      nodeId: progress.nodeId,
      ...(progress.conversationId ? { conversationId: progress.conversationId } : {}),
      worktreePath: worktree.path,
      branch: worktree.branch
    })
    /** The node as far as the canvas has reported it, so a failure after that can stop its session. */
    let node: TicketSessionProgress | undefined
    /** Whether the caller was answered `pending`, which hands the verdict to `onSettled`. */
    let answeredPending = false
    // The caller's records of the session, in the order the canvas reported it: a verdict is
    // never reported before the link it settles.
    let linking: Promise<void> = Promise.resolve()
    let linkFailure: { error: unknown } | undefined
    const stop = (nodeId: string | undefined): void => {
      if (nodeId) options.canvas.cancelTicketSession?.(nodeId)
    }

    // Confirmed, not requested: what the session reports is what the caller is told.
    const settle = (answer: { nodeId: string; conversationId: string }): TicketSpawnSettlement => {
      const running = options.session(answer.nodeId)
      const confirmed = [...warnings]
      if (running?.model && running.model !== request.model) {
        confirmed.push(`the session runs on model "${running.model}", not "${request.model}"`)
      }
      if (running?.effort && running.effort !== request.effort) {
        confirmed.push(`the session runs at effort "${running.effort}", not "${request.effort}"`)
      }
      return {
        ok: true,
        session: {
          nodeId: answer.nodeId,
          conversationId: answer.conversationId,
          worktreePath: worktree.path,
          branch: worktree.branch
        },
        ...(running?.model ? { model: running.model } : {}),
        ...(running?.effort ? { effort: running.effort } : {}),
        warnings: confirmed
      }
    }

    let started: TicketSessionCanvasResult
    try {
      started = await options.canvas.startTicketSession(canvasRequest, {
        ...(request.startTimeoutMs !== undefined ? { timeoutMs: request.startTimeoutMs } : {}),
        progress: (progress) => {
          node = progress
          linking = linking
            .then(() => request.onSession?.(linked(progress)))
            .catch((error) => {
              linkFailure ??= { error }
            })
        },
        // What the canvas settles after the caller was told `pending`. Without that answer nobody
        // is tracking the session, so one that comes up anyway is withdrawn rather than left working.
        late: (result) => {
          if (!answeredPending) {
            if (result.ok) stop(result.nodeId)
            return
          }
          void linking.then(() => {
            if (linkFailure) {
              stop(node?.nodeId)
              request.onSettled?.({
                ok: false,
                error: `the session could not be recorded: ${errorMessage(linkFailure.error)}`
              })
            } else if (result.ok) request.onSettled?.(settle(result))
            else request.onSettled?.({ ok: false, error: result.message })
          })
        }
      })
      await linking
      if (linkFailure) throw linkFailure.error
    } catch (error) {
      // Toucan treats this start as failed, so its session is stopped, not only left in its worktree.
      stop(node?.nodeId)
      throw error
    }
    if (started.ok) return settle(started)
    if ('pending' in started) {
      const nodeId = started.nodeId ?? node?.nodeId
      if (nodeId) {
        answeredPending = true
        return {
          ok: false,
          pending: true,
          session: linked({ nodeId, conversationId: started.conversationId ?? node?.conversationId }),
          error: started.message
        }
      }
    }
    // A failure verdict means the canvas has already dropped the session's prompt and shows why.
    return { ok: false, error: `${started.message} The worktree stays at ${worktree.path} on ${worktree.branch}.` }
  }

  return {
    async spawn(request) {
      try {
        return await spawn(request)
      } catch (error) {
        return { ok: false, error: `Toucan could not spawn the ticket session: ${errorMessage(error)}` }
      }
    }
  }
}
