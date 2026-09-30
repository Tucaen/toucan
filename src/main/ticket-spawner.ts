import {
  ticketBranchCandidates,
  ticketSessionPrompt,
  ticketSessionTitle,
  type OrchestrationTicket,
  type TicketSession
} from '../shared/orchestration'
import { errorMessage } from '../shared/text'
import type { TicketSessionCanvasRequest, TicketSessionCanvasResult } from '../shared/ticket-session-spawn'
import type { GitRunner, WorktreeManager } from './git-worktree'
import type { PushGuardResult } from './ticket-push-guard'

/**
 * What the orchestrator endpoint asks for once a `spawn` is authorized and counted (#34; plan in
 * `docs/plans/orchestrator-mode.md`): one ticket session in a worktree Toucan creates for it.
 */
export interface TicketSpawnRequest {
  /** The orchestrator the session is linked to by its orchestrated-by edge. */
  orchestrator: { nodeId: string; conversationId: string }
  /** The orchestrator's project checkout; the worktree is created from it. */
  projectPath: string
  /** The branch the orchestration merges into; the ticket branch starts from it. */
  targetBranch: string
  ticket: OrchestrationTicket
  model: string
  effort: string
}

export type TicketSpawnResult =
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

export interface TicketSpawner {
  /** Never rejects: every failure is `{ ok: false }` with the reason the CLI prints. */
  spawn(request: TicketSpawnRequest): Promise<TicketSpawnResult>
}

/** What the spawner reads of a live session: the orchestrator's mode, the ticket session's model. */
export interface SessionSettings {
  permissionMode?: string
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
  canvas: { startTicketSession(request: TicketSessionCanvasRequest): Promise<TicketSessionCanvasResult> }
  /** A live session's settings by node id, from the event broker's snapshot. */
  session(nodeId: string): SessionSettings | undefined
  /** The Claude models the picker offers; empty when no Claude session has advertised any yet. */
  offeredModels(): readonly string[]
  /** A worktree main created, so the chat launching in it is not refused as outside the workspace. */
  onWorktreeCreated(path: string): void
}

/**
 * Creates the worktree, guards it, sets it up, and only then asks the canvas for the chat - so a
 * ticket session never starts in a checkout that can push or that is missing its dependencies. A
 * worktree that fails before the canvas has seen it is removed again with its branch: both are
 * seconds old and hold nothing but the target branch's commits. One the canvas has registered
 * stays, because from then on it is a canvas entity the human can see and remove.
 */
export function createTicketSpawner(options: TicketSpawnerOptions): TicketSpawner {
  const discard = async (projectPath: string, path: string, branch: string): Promise<void> => {
    await options.runGit(['worktree', 'remove', '--force', path], projectPath)
    await options.runGit(['branch', '-D', branch], projectPath)
  }

  const createWorktree = async (
    request: TicketSpawnRequest
  ): Promise<{ path: string; branch: string; baseRef: string } | { error: string }> => {
    for (const branch of ticketBranchCandidates(request.ticket.id)) {
      const created = await options.worktrees.create({
        projectPath: request.projectPath,
        branch,
        baseRef: request.targetBranch
      })
      if (created.ok && created.worktree) return created.worktree
      if (!created.conflict) return { error: `the worktree could not be created: ${created.message ?? 'git failed'}` }
    }
    return { error: `every ticket branch name for "${request.ticket.id}" is already taken` }
  }

  const spawn = async (request: TicketSpawnRequest): Promise<TicketSpawnResult> => {
    const project = await options.project(request.projectPath)
    if (!project) return { ok: false, error: `the project ${request.projectPath} is not open in Toucan` }
    const offered = options.offeredModels()
    if (offered.length > 0 && !offered.includes(request.model)) {
      return { ok: false, error: `model "${request.model}" is not offered; the picker offers ${offered.join(', ')}` }
    }
    // Read before anything is created, so the ticket session inherits the mode the orchestrator
    // had when it asked.
    const permissionMode = options.session(request.orchestrator.nodeId)?.permissionMode

    const worktree = await createWorktree(request)
    if ('error' in worktree) return { ok: false, error: worktree.error }
    options.onWorktreeCreated(worktree.path)

    const guarded = await options.installGuard(worktree.path)
    if (!guarded.ok) {
      await discard(request.projectPath, worktree.path, worktree.branch)
      return { ok: false, error: guarded.error }
    }
    const setupCommand = project.setupCommand?.trim()
    if (setupCommand) {
      const setup = await options.runSetup(setupCommand, worktree.path)
      if (!setup.ok) {
        await discard(request.projectPath, worktree.path, worktree.branch)
        return { ok: false, error: `the setup command failed, so the worktree was removed again: ${setup.error}` }
      }
    }

    const started = await options.canvas.startTicketSession({
      projectId: project.id,
      worktree,
      label: ticketSessionTitle(request.ticket),
      modelId: request.model,
      effortId: request.effort,
      ...(permissionMode ? { permissionMode } : {}),
      orchestratedBy: request.orchestrator,
      prompt: ticketSessionPrompt(request.ticket, worktree)
    })
    if (!started.ok) {
      return { ok: false, error: `${started.message} The worktree stays at ${worktree.path} on ${worktree.branch}.` }
    }

    // Confirmed, not requested: what the session reports is what the caller is told.
    const running = options.session(started.nodeId)
    const warnings: string[] = []
    if (running?.model && running.model !== request.model) {
      warnings.push(`the session runs on model "${running.model}", not "${request.model}"`)
    }
    if (running?.effort && running.effort !== request.effort) {
      warnings.push(`the session runs at effort "${running.effort}", not "${request.effort}"`)
    }
    return {
      ok: true,
      session: {
        nodeId: started.nodeId,
        conversationId: started.conversationId,
        worktreePath: worktree.path,
        branch: worktree.branch
      },
      ...(running?.model ? { model: running.model } : {}),
      ...(running?.effort ? { effort: running.effort } : {}),
      warnings
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
