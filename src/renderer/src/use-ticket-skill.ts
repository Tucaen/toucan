import { useCallback, useEffect, useState } from 'react'
import type { TicketSkillApi, TicketSkillPresence } from '../../shared/ticket-skill'

/**
 * Whether this project has a tickets skill of its own, and the one action that gives it one.
 * Kept beside `use-ticket-board.ts` rather than inside it because it is not about tickets at all:
 * a board full of cards and a board with none can both be a project whose agents have never been
 * told the convention.
 *
 * Two rules the panel above it does not get to bend. The probe is for the *label* only - main
 * refuses an existing skill on its own, exclusively, so a stale answer here can cost a refusal and
 * never a file. And an outcome belongs to the project it happened in: switching projects clears it
 * rather than leaving "Skill written" over a checkout that has none.
 */

export type TicketSkillOutcome = { ok: true; path: string } | { ok: false; message: string }

export interface TicketSkillOffer {
  /**
   * `unknown` until the probe answers, and again if it could not - a bridge that failed says
   * nothing about the checkout, which is exactly what `unknown` means on the other side too.
   */
  status: TicketSkillPresence
  /** The skill file relative to the checkout, for naming it to the user. */
  path?: string
  /** True while the write is out; the action is its own progress indicator. */
  pending: boolean
  outcome?: TicketSkillOutcome
  /** Writes the starter skill, then re-probes so the label matches what is now on disk. */
  write(): Promise<void>
  /** Shows the skill file in the OS file manager - the natural next step after either outcome. */
  reveal(): void
  dismiss(): void
}

export interface TicketSkillOptions {
  api: TicketSkillApi
  projectPath?: string
}

export function useTicketSkill(options: TicketSkillOptions): TicketSkillOffer {
  const { api, projectPath } = options
  const [status, setStatus] = useState<TicketSkillPresence>('unknown')
  const [path, setPath] = useState<string | undefined>(undefined)
  const [pending, setPending] = useState(false)
  const [outcome, setOutcome] = useState<TicketSkillOutcome | undefined>(undefined)

  const probe = useCallback(async (): Promise<void> => {
    if (!projectPath) {
      setStatus('unknown')
      setPath(undefined)
      return
    }
    const state = await api.state(projectPath).catch(() => undefined)
    setStatus(state?.status ?? 'unknown')
    if (state) setPath(state.path)
  }, [api, projectPath])

  useEffect(() => {
    setOutcome(undefined)
    setPending(false)
    setStatus('unknown')
    void probe()
  }, [probe])

  const write = useCallback(async (): Promise<void> => {
    if (!projectPath) return
    setPending(true)
    const result = await api.write(projectPath).catch((cause: unknown) => ({
      ok: false as const,
      code: 'write-failed',
      message: cause instanceof Error ? cause.message : 'The skill could not be written.'
    }))
    setPending(false)
    setOutcome(result.ok ? { ok: true, path: result.path } : { ok: false, message: result.message })
    // Whatever happened, what the board now says about the project comes from disk.
    await probe()
  }, [api, probe, projectPath])

  return {
    status,
    path,
    pending,
    outcome,
    write,
    reveal: () => {
      if (projectPath) api.revealInFolder(projectPath)
    },
    dismiss: () => setOutcome(undefined)
  }
}
