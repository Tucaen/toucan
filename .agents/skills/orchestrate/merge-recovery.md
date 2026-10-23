# Merge recovery

## Rebase conflict

Your pre-merge rebase stopped on a conflict and you aborted it, so the worktree is back at the ticket's own HEAD. Use `followup --ticket <id> --text <text>` to send the conflict to that ticket's session: name the target, the conflicted files Git listed and the intended behavior, and ask it to rebase onto the target, resolve, continue the rebase, run the full suite and report the commit tested. A report that the rebase is unresolved, or a worktree still mid-rebase, is a failed resolution attempt; send it back the same way. The contract permits this requested rebase recovery; it still forbids a merge, push or PR.

Record the conflict attempt and follow-up delivery in the ticket's body before ending your turn. A queued follow-up is pending work, not a successful resolution. On its wake, inspect the outcome and Git's rebase state. After **two failed resolution attempts**, leave `mergeStatus: unmerged`, retain the worktree and conflict evidence, comment the reason on its tracker and report its blocked dependents. Do not escalate or restart to reset this counter. A pending human permission prompt does not consume an attempt.

## Push rejected

A `merge` refused at `stage: push` keeps the ticket pending: the target checkout holds the merge, its upstream does not. For a non-fast-forward rejection (`rejected: true`), fetch the target's configured remote, then rebase the target onto its fetched upstream in the orchestrator checkout. Then rebase the ticket branch onto the updated target and have its session run the full test suite, as in Merge step 1, and end your turn. On its wake, retry with `merge --ticket <id> --tested <commit>` naming the newly tested commit. Any new changes from conflict resolution must again pass the suite and reach the target via `--ff-only`.

If that target rebase conflicts, abort it to restore the local target, and send the conflicting integration back to the ticket session: have it rebase its ticket branch onto the fetched upstream under the same two-attempt rule. After resolution and the full suite, verify the rewritten branch contains all intended unpublished target work. Preserve the original target tip under a local recovery ref. With the target checkout clean, on the same branch, and its HEAD still at that recorded tip, align it with the fetched upstream using `git reset --keep <upstream>` and retry `merge` with the tested commit. If any of these facts is uncertain, leave the target and ticket for review; never discard unrelated work to make a push succeed.

Retry at most twice for remote races in this merge. Authentication, permission and connectivity errors require their own remedy; repeated pushes do not resolve them. On exhaustion, keep the local result and recovery ref, mark the ticket unmerged, comment the reason and report it. Never force-push. A successful retry records the **new** published commit link, not the pre-rebase hash.
