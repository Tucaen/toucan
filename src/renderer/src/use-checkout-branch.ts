import { useCallback, useEffect, useState } from 'react'
import type { GitBranchState } from '../../shared/git-branch'

/** Git only moves when something outside the app moves it, so this can be lazy. */
const BRANCH_POLL_MS = 10_000

/**
 * Which branch the checkout at `directory` is on, re-read on an interval because a branch changes
 * from outside Toucan - the agent itself, a terminal, another editor - and git has nothing to
 * subscribe to. A failed read keeps the last good answer rather than blanking the indicator, so a
 * momentary lock or an index rewrite mid-checkout does not flicker the row.
 *
 * `revision` is for the one case where Toucan itself moved the branch: bumping it re-reads at
 * once instead of leaving the row stale for up to a poll interval after the user's own click.
 */
export function useCheckoutBranch(directory: string, revision = 0): GitBranchState | null {
  const [state, setState] = useState<GitBranchState | null>(null)

  const read = useCallback(async (): Promise<GitBranchState | null> => {
    try {
      return await window.worktreeApi.currentBranch(directory)
    } catch {
      // Either git would not answer or the bridge is not there at all - a node still renders
      // without a branch, so neither is worth propagating past this row.
      return null
    }
  }, [directory])

  useEffect(() => {
    let active = true
    // A different directory is a different checkout, so the previous answer is not a fallback.
    setState(null)
    const poll = (): void => {
      void read().then((next) => {
        if (active && next) setState(next)
      })
    }
    poll()
    const interval = setInterval(poll, BRANCH_POLL_MS)
    return () => {
      active = false
      clearInterval(interval)
    }
  }, [read])

  useEffect(() => {
    if (revision === 0) return
    let active = true
    void read().then((next) => {
      if (active && next) setState(next)
    })
    return () => {
      active = false
    }
  }, [read, revision])

  return state
}
