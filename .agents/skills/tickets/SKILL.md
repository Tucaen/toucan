---
name: tickets
description: Create and update a project's Markdown tickets. Use when the user asks for a ticket, when work needs to be tracked in a project that has no reachable issue tracker, or when a ticket's status, blockers or scope changed.
---

# Tickets

A ticket is one Markdown file in the project's tickets folder, and **the file is the truth**. Toucan's board renders and mutates those files; it keeps no second copy of ticket state. Humans, agents and the board all read and write the same file, so a change you make is the change everyone sees.

Use this convention only for a project whose tickets live in the checkout. When the project has a reachable issue tracker the user already works in (GitHub issues, Jira), file the work there instead and say so; do not mirror tracker issues into files.

## Where the files live

`docs/tickets/` in the project root, unless the project's Toucan entry sets `ticketsDirectory`. Create the folder when you write the first ticket. Only direct `.md` children are tickets: no subfolders, no index file, no `archived/` folder — a closed ticket keeps `status: done` until the user deletes it, and git history is the archive.

## File shape

```markdown
---
title: Short imperative title
status: open
created: 2026-09-04
updated: 2026-09-04
blocked_by: shared-frontmatter, ticket-board
---

Body in ordinary Markdown: context, acceptance criteria, notes.
```

- **Filename is the id.** A lowercase kebab-case slug plus `.md` (`ticket-board.md` → `ticket-board`), unique in the folder. Name it after the work, not after a number or a date, and keep it stable once written — `blocked_by` and every link elsewhere point at it.
- **Frontmatter is flat.** One `key: value` per line, no nesting, no lists, no quoting. A duplicated key or a line that is neither a field nor a `#` comment makes the file unreadable.
- `title`, `status`, `created` and `updated` are required. `blocked_by` is optional.
- Dates are `YYYY-MM-DD`. Never invent them: read today's date from the environment.
- Everything after the closing `---` is the body. Write it for whoever picks the ticket up: the problem, what "done" means, and any decision already made. Keep discussion that is not actionable out of it.

## Status

`open`, `in-progress`, `blocked`, `done` — the four columns Toucan ships. An unknown status is tolerated and simply becomes an extra column, so a project may invent one; write it as one lowercase kebab-case word (`review`, not `In Review`) and prefer the four defaults unless the user asked for another.

Flip `status` when the observable state changed, and bump `updated` in the same edit — a status the board shows with a stale `updated` is worse than either alone. Never move a ticket to `done` from inferred completion: it is done when the work is merged or the user says so. Set `blocked` only when something outside the ticket must happen first, and record what in `blocked_by` or, when the blocker is not another ticket in this folder, in one sentence in the body.

## Blockers

`blocked_by` is a comma separated list of slugs of tickets **in the same folder**, and nothing else. A pull request, an upstream release, or a ticket in another project's folder is prose in the body, not a slug. Do not list a ticket as blocking itself, and drop a slug once its ticket is `done`.

## Working on tickets

- Read every direct `.md` child of the folder before creating a ticket: extend the ticket that already covers the work rather than opening a near-duplicate.
- One ticket is one slice of work someone can pick up and finish. Split a request that has two independent outcomes; do not split a single change into a file per file it touches.
- Editing a ticket means rewriting the body to the current understanding, not appending a log. Keep the decisions and constraints; drop the superseded speculation.
- Leave a file you cannot parse alone and report it. A malformed ticket shows on the board as a diagnostic row; silently rewriting it loses whatever the human meant.

## Completion

Report which slugs you created, updated and closed, and nothing else:

```text
Created 2 tickets (ticket-board, live-session-cards). Updated 1 (shared-frontmatter → done).
```
