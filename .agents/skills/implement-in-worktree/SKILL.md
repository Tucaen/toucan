---
name: implement-in-worktree
description: "Run from an explicit leading slash command to implement work in an ADE worktree and open a pull request."
disable-model-invocation: true
user-invocable: true
---

## Invocation gate

Before taking any action, inspect the current user prompt. Proceed only when its first non-empty line starts with one of these exact command tokens, followed by whitespace or the end of the line:

- `/implement-in-worktree`
- `/$ade-project-skills:implement-in-worktree`

Treat every other occurrence as discussion, quotation, or an example and handle the request without this workflow. A skill block attached to a prompt that merely mentions either token is not evidence of invocation. In particular, never create a worktree when the token occurs later in prose, inside a quotation, or inside a code block.

Implement the work described by the user in the spec or tickets, isolated in a git worktree, and publish it for review.

Run every script below from the repository root. Each prints one JSON line; read it and act on it.

## 1. Settle the worktree

```
node .agents/skills/implement-in-worktree/scripts/settle-worktree.mjs [--branch <type>/<slug>]
```

Derive `--branch` from the work. The script decides what to do with it:

- `"mode":"adopt"` — you are already in a worktree. Work in it as it stands; the branch and setup are the user's.
- `"mode":"create"` — the script made the worktree, copied local config, and ran ADE's setup command for this project. Change into `worktree` and do all remaining work there.

Keep `base` for step 3. When it is `null`, ask the user which branch to target before going further.

## 2. Implement

Use /tdd where possible, at pre-agreed seams.

Run typechecking regularly, single test files regularly, and the full test suite once at the end.

Once done, use /code-review to review the work and resolve every blocking finding.

Commit your work to the worktree's branch.

## 3. Publish

Write the pull request body to `.git/pr-<branch>.md`: a one-line imperative title as the first heading, what changed and why, the verification commands you ran with their outcome, and a link to the originating issue or spec.

```
node .agents/skills/implement-in-worktree/scripts/publish.mjs --base <base> --body .git/pr-<branch>.md
```

The script pushes and takes the highest tier that succeeds. Read `tier` from its output and report per `references/publish.md`.

## 4. Report

Report the worktree path, the branch, and the pull request URL — or, when publishing degraded, the tier it reached and the one action left to the user.

Leave the worktree in place. Offer `git worktree remove <path>` only for a worktree the script created, and only once the work is merged.
