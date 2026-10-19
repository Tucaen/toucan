# Merge recovery

## Rebase conflict

The ticket session meets a conflict itself while rebasing on your merge follow-up, and the conflict stays in its worktree. A report that the rebase is unresolved, or a worktree still mid-rebase, is a failed resolution attempt. Use `followup --ticket <id> --text <text>` to send it back to that same session: name the target, the conflicted files from its report and the intended behavior, and ask it to resolve, continue the rebase, run the full suite and report the commit tested. The contract permits this requested rebase recovery; it still forbids a merge, push or PR.

Record the conflict attempt and follow-up delivery in the ticket's body before ending your turn. A queued follow-up is pending work, not a successful resolution. On its wake, inspect the outcome and Git's rebase state. After **two failed resolution attempts**, leave `mergeStatus: unmerged`, retain the worktree and conflict evidence, comment the reason on its tracker and report its blocked dependents. Do not escalate or restart to reset this counter. A pending human permission prompt does not consume an attempt.

## Push rejected

Keep the ticket pending until publication succeeds. For a non-fast-forward rejection, fetch the target's configured remote, then rebase the target onto its fetched upstream in the orchestrator checkout. Then `followup` the ticket session to rebase its branch onto the updated target and run the full test suite there, and end your turn. On its wake, confirm the tested commit equals the proposed target HEAD before retrying the target push. Any new changes from conflict resolution must again pass the suite and reach the target via `--ff-only`.

If that target rebase conflicts, abort it to restore the local target, and send the conflicting integration back to the ticket session: have it rebase its ticket branch onto the fetched upstream under the same two-attempt rule. After resolution and the full suite, verify the rewritten branch contains all intended unpublished target work. Preserve the original target tip under a local recovery ref. With the target checkout clean, on the same branch, and its HEAD still at that recorded tip, align it with the fetched upstream using `git reset --keep <upstream>` and fast-forward the tested ticket branch. If any of these facts is uncertain, leave the target and ticket for review; never discard unrelated work to make a push succeed.

Retry at most twice for remote races in this merge. Authentication, permission and connectivity errors require their own remedy; repeated pushes do not resolve them. On exhaustion, keep the local result and recovery ref, mark the ticket unmerged, comment the reason and report it. Never force-push. A successful retry records the **new** published commit link, not the pre-rebase hash.
