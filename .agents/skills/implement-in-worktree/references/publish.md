# Publishing tiers

`publish.mjs` degrades through three tiers and reports which one it reached. Every tier leaves the commits and the PR body file intact, so a degraded run is always one manual step from a pull request.

## `hosted`

The pull request exists. Report `url`.

## `linked`

The branch is pushed but no pull request was created — `reason` says why (no `gh` auth, no `BITBUCKET_TOKEN`, an API refusal, an unrecognised host).

Report `url` and `bodyFile`: the compare page needs no authentication, and the user pastes the body into it. Report `reason` too, so the user can fix the cause rather than repeat the paste.

`url` is `null` only for a host with no known compare page. Then report the pushed branch and let the user open the pull request their own way.

## `local`

Nothing was pushed — no remote, or the push failed after a retry. `reason` carries the failure.

Report the branch, the worktree path, `bodyFile`, the `commits` list, and `next`:

```
git switch <base> && git merge --no-ff <branch>
```

That runs in the main checkout, not the worktree — a worktree's branch is an ordinary branch in the same repository. Offer to run it, and wait for the user to accept: it moves their base branch.

A push rejected for a diverged remote is not a transient failure. Rebase onto the updated base branch and run `publish.mjs` again.
