import {
  orchestrationBranchScope,
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
  /**
   * How long the canvas may stay silent - no node, no output - before a start it has not shown a
   * node for is given up; the default when absent. A start whose node exists is waited out (#1).
   */
  startTimeoutMs?: number
  /**
   * The worktree exists and is guarded (Tucaen/toucan#3): the caller records the attempt now, and
   * `spawn` answers once it has, before the setup command and the canvas. A throw fails the spawn
   * and removes the worktree again.
   */
  onAttempt?(attempt: TicketAttempt): Promise<void> | void
  /**
   * The canvas holds the session's node and it is not up yet (#1), and again once it has a
   * conversation id: the caller records it against the ticket now, so a start that is slow - or
   * never finishes - leaves a linked session rather than an invisible one.
   */
  onSession?(session: LinkedTicketSession): Promise<void> | void
}

/** Where an attempt runs, known as soon as its worktree exists. */
export type TicketAttempt = Required<Pick<TicketSession, 'worktreePath' | 'branch'>>

/** A worktree as the worktree manager created it. */
type CreatedWorktree = { path: string; branch: string; baseRef: string }

const attemptOf = (worktree: CreatedWorktree): TicketAttempt => ({
  worktreePath: worktree.path,
  branch: worktree.branch
})

/** A ticket session as far as is known: the conversation comes with the session's first output. */
export type LinkedTicketSession = Omit<Required<TicketSession>, 'conversationId'> & { conversationId?: string }

/** How an admitted spawn's start ended: its session is up, or the attempt is over. */
export type TicketSpawnSettlement =
  | {
      ok: true
      session: Required<TicketSession>
      /** The model and effort the running session reports, read back rather than assumed. */
      model?: string
      effort?: string
      /** What the caller should know but that did not stop the start. */
      warnings: string[]
    }
  | {
      ok: false
      error: string
      /** What the failure left behind or removed: the worktree, its branch, the node. */
      cleanup: string
      /** The caller cancelled the start; nothing of it is news to the orchestrator. */
      cancelled?: true
    }

export type TicketSpawnResult =
  /** Refused, or failed before the attempt existed: nothing is left behind unless `error` says so. */
  | { ok: false; error: string }
  | {
      ok: true
      /** Recorded through `onAttempt` before this answer. */
      attempt: TicketAttempt
      /** The setup command and the canvas, still running; never rejects. */
      settled: Promise<TicketSpawnSettlement>
      /**
       * The attempt is superseded or discarded: its setup is stopped, the canvas is not asked, and a
       * node it already has is closed. Its worktree stays for whoever cancelled it.
       */
      cancel(): void
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
  runSetup(command: string, cwd: string, signal?: AbortSignal): Promise<{ ok: true } | { ok: false; error: string }>
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
 * Creates the worktree and guards it, and answers once the caller has recorded the attempt
 * (Tucaen/toucan#3): the setup command - minutes, up to fifteen - and the canvas run on in
 * `settled`, so an orchestrator's `spawn` never holds its turn open for them. Setup comes before
 * the canvas, so a ticket session never starts in a checkout that can push or that is missing its
 * dependencies. A project without a setup command has nothing to install them with, so that start
 * says so in its warnings instead of starting the chat as if the worktree were ready. A worktree
 * that fails before the canvas has seen it is removed again with its branch: it holds nothing but
 * the target branch's commits. One the canvas has registered stays, because from then on it is a
 * canvas entity the human can see and remove.
 */
export function createTicketSpawner(options: TicketSpawnerOptions): TicketSpawner {
  /** Removes a worktree only this spawn has seen, and says what came of it. */
  const discard = async (projectPath: string, worktree: TicketAttempt): Promise<string> => {
    const removed = await options.runGit(['worktree', 'remove', '--force', worktree.worktreePath], projectPath)
    if (removed.code !== 0) {
      return `the worktree could not be removed and stays at ${worktree.worktreePath} on ${worktree.branch}`
    }
    const deleted = await options.runGit(['branch', '-D', worktree.branch], projectPath)
    return deleted.code === 0
      ? 'the worktree and its branch were removed again'
      : `the worktree was removed, but its branch ${worktree.branch} could not be deleted`
  }

  const createWorktree = async (request: TicketSpawnRequest): Promise<CreatedWorktree | { error: string }> => {
    // The names never run out, so this ends at the first free one or a failure that is no conflict.
    // They are scoped to the orchestration, so another one's ticket of the same id is no conflict.
    const scope = orchestrationBranchScope({
      provider: orchestratorProvider(request.orchestrator),
      conversationId: request.orchestrator.conversationId
    })
    for (const branch of ticketBranchCandidates(scope, request.ticket.id)) {
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

  /** What one admitted attempt's start knows while it runs, and what cancelling it reaches. */
  interface StartControl {
    cancelled: boolean
    abort: AbortController
    /** The node as far as the canvas has reported it, so a failure after that can stop its session. */
    node?: TicketSessionProgress
  }

  const stop = (nodeId: string | undefined): void => {
    if (nodeId) options.canvas.cancelTicketSession?.(nodeId)
  }

  /** The setup command and the canvas, after `spawn` answered. */
  const start = async (
    request: TicketSpawnRequest,
    project: { id: string; setupCommand?: string },
    worktree: CreatedWorktree,
    control: StartControl
  ): Promise<TicketSpawnSettlement> => {
    const provider = orchestratorProvider(request.orchestrator)
    const stays = `the worktree stays at ${worktree.path} on ${worktree.branch}`
    const cancelled: TicketSpawnSettlement = {
      ok: false,
      error: 'the start was cancelled',
      cleanup: stays,
      cancelled: true
    }
    const warnings: string[] = []
    const setupCommand = project.setupCommand?.trim()
    if (!setupCommand) {
      warnings.push(
        `the project has no setup command, so nothing was installed in ${worktree.path}; ` +
          "set its Setup command in the project's settings in Toucan, or install dependencies in the session"
      )
    } else {
      const setup = await options.runSetup(setupCommand, worktree.path, control.abort.signal)
      if (control.cancelled) return cancelled
      if (!setup.ok) {
        return {
          ok: false,
          error: `the setup command failed: ${setup.error}`,
          cleanup: await discard(request.projectPath, attemptOf(worktree))
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
    if (control.cancelled) return cancelled

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
    // The caller's records of the session, in the order the canvas reported it: a verdict is
    // never reported before the link it settles.
    let linking: Promise<void> = Promise.resolve()
    let linkFailure: { error: unknown } | undefined

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

    let verdict: TicketSessionCanvasResult
    try {
      verdict = await new Promise<TicketSessionCanvasResult>((resolve, reject) => {
        // A wait that ran out with the node on the canvas is no verdict (#1): the start is still
        // going, and the window's eventual answer arrives through `late`.
        let awaitingLate = false
        // The window may answer before the timed-out answer is read here; it is kept until then.
        let answered = false
        let early: TicketSessionCanvasResult | undefined
        const withdraw = (result: TicketSessionCanvasResult | undefined): void => {
          if (result?.ok) stop(result.nodeId)
        }
        options.canvas
          .startTicketSession(canvasRequest, {
            ...(request.startTimeoutMs !== undefined ? { timeoutMs: request.startTimeoutMs } : {}),
            progress: (progress) => {
              control.node = progress
              if (control.cancelled) {
                stop(progress.nodeId)
                return
              }
              linking = linking
                .then(() => request.onSession?.(linked(progress)))
                .catch((error) => {
                  linkFailure ??= { error }
                })
            },
            late: (result) => {
              if (awaitingLate) resolve(result)
              else if (!answered) early = result
              // Given up on without a node, so nobody tracks it: one that comes up anyway is withdrawn.
              else withdraw(result)
            }
          })
          .then((result) => {
            answered = true
            if (!result.ok && 'pending' in result && (result.nodeId ?? control.node?.nodeId)) {
              if (early) resolve(early)
              else awaitingLate = true
            } else {
              resolve(result)
              withdraw(early)
            }
          }, reject)
      })
      await linking
      if (linkFailure) throw linkFailure.error
    } catch (error) {
      // Toucan treats this start as failed, so its session is stopped, not only left in its worktree.
      stop(control.node?.nodeId)
      return {
        ok: false,
        error: `Toucan could not start the ticket session: ${errorMessage(error)}`,
        cleanup: control.node ? `${stays}; Toucan closed its session` : stays
      }
    }
    if (control.cancelled) {
      if (verdict.ok) stop(verdict.nodeId)
      return cancelled
    }
    if (verdict.ok) return settle(verdict)
    if ('pending' in verdict) {
      return { ok: false, error: 'the canvas did not show the ticket session in time', cleanup: stays }
    }
    // A failure verdict means the canvas has already dropped the session's prompt and shows why.
    return {
      ok: false,
      error: verdict.message,
      cleanup: control.node ? `${stays}, and its node stays on the canvas without the ticket prompt` : stays
    }
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
    const attempt = attemptOf(worktree)

    const guarded = await options.installGuard(worktree.path)
    if (!guarded.ok) return { ok: false, error: `${guarded.error}; ${await discard(request.projectPath, attempt)}` }
    try {
      await request.onAttempt?.(attempt)
    } catch (error) {
      return {
        ok: false,
        error: `the attempt could not be recorded: ${errorMessage(error)}; ${await discard(request.projectPath, attempt)}`
      }
    }

    const control: StartControl = { cancelled: false, abort: new AbortController() }
    const settled = start(request, project, worktree, control).catch((error): TicketSpawnSettlement => ({
      ok: false,
      error: `Toucan could not start the ticket session: ${errorMessage(error)}`,
      cleanup: `the worktree stays at ${worktree.path} on ${worktree.branch}`
    }))
    return {
      ok: true,
      attempt,
      settled,
      cancel: () => {
        if (control.cancelled) return
        control.cancelled = true
        control.abort.abort()
        stop(control.node?.nodeId)
      }
    }
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
