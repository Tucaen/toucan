---
title: Ticket board and file nodes plan
created: 2026-09-04
updated: 2026-09-21
status: shipped v0.2.0 (from a NodeTerm feature review, 2026-09-04)
---

# Ticket board and file nodes plan

Two workflow gaps surfaced while reviewing NodeTerm (https://nodeterm.dev) against Toucan:

1. Projects without a reachable issue tracker get their tickets as Markdown files that agents
   write into the checkout. Their status is invisible until every file is opened.
2. Reading a generated Markdown file, checking a file's content, or reviewing what an agent
   changed still needs VS Code open beside Toucan.

Everything else NodeTerm offers was reviewed and parked: agent-to-agent context links (subagents
and pasting cover it), sticky notes (slower than the prompt queue), a context meter (exists),
tmux-style terminal persistence (plain terminals only run dev servers now), conversation
branching and worktree groups (no felt need yet).

## Decisions

- **Tickets are files, and the files are the truth.** One Markdown file per ticket with YAML
  frontmatter, in a folder inside the project checkout. Toucan renders and mutates the files; it
  never keeps a second copy of ticket state. Agents and humans edit the same files, so the
  convention is documented once, in a skill agents can read, and the board is only a projection.
- **Convention before UI.** The file shape and the skill land first so agents can start writing
  conforming tickets before the board exists.
- **The board is a docked panel, not a canvas node.** Same shell as the brain-dump library
  (sibling of `.canvas-region` in `.workspace-shell`, lazily mounted, then `hidden`); it shows the
  active project's tickets. A board has no geometry worth persisting on the canvas.
- **Files and diffs are canvas nodes.** A file you are reading sits next to the chat that produced
  it and a diff sits next to the worktree it reviews. Both persist like worktree nodes do:
  an optional array on `WorkspaceState`, no version bump, restored by `restoreCanvasWorkspace`.
- **Read first, edit last.** The file node renders Markdown by default with a raw, highlighted
  toggle. Editing (Monaco or similar) is a separate later ticket because the observed use is
  reading, and an editor is the heaviest piece.
- **Diffs come from git, not from transcripts.** A diff node runs `git diff` against the
  worktree's recorded `baseRef` (or `HEAD` for the primary checkout) so it shows what is actually
  on disk, including edits from several sessions. The per-hunk rendering reuses the transcript's
  file-operation blocks.
- **Status closes a ticket; deleting removes it.** Unlike brain dumps, a ticket is never
  rewritten as a summary and needs no immutable snapshot, so `status: done` is the only closure
  signal and the Done column is collapsed by default. When a project accumulates hundreds of
  closed tickets, the user deletes them from the board (#149) so list and agent read cost stay
  proportional to live tickets. There is no `archived/` folder: every project is a git checkout,
  so history already keeps deleted tickets readable, and a second folder would only add reserved
  names, skill rules and blocker states for files nobody lists.
- **The board reads several sources through one seam.** A `TicketSource` in `src/shared/`
  (id, `list` returning cards plus diagnostics, optional `setStatus` and `openExternal`
  capabilities). The files source is always on; GitHub is detected per project and switched on
  from the board; further trackers plug in the same way. A local Markdown ticket stays useful
  even when a real tracker exists, so sources are additive, never exclusive. Cards are keyed by
  source plus id and carry a source badge; a column accepts drops only from sources that can set
  status. `blocked_by` references file slugs only; cross-source links are prose in the body.
- **Ticket folder is per project, with a default.** `docs/tickets/` unless the project sets
  `ticketsDirectory`. Optional field on `WorkspaceProject`, accepted by the store validator.

## Ticket file shape

```markdown
---
title: Short imperative title
status: open | in-progress | blocked | done
created: 2026-09-04
updated: 2026-09-04
blocked_by: other-slug, another-slug   # optional, comma separated slugs
---

Body: context, acceptance criteria, notes. Ordinary Markdown.
```

- Filename is the ticket id: lowercase kebab-case slug plus `.md`, unique in the folder.
- `status` values beyond the four defaults are tolerated and render as extra columns, so a
  project may add `review` without a Toucan change.
- A file that fails to parse is listed on the board as a diagnostic row, never dropped silently
  (same posture as `BrainDumpDiagnostic`).

## Architectural notes (from code survey, 2026-09-04)

- Frontmatter parsing, atomic rewrite through a temporary file, and the debounced per-folder
  watcher all exist for brain dumps (`src/main/brain-dump-library.ts`,
  `src/main/brain-dump-watcher.ts`). The ticket library must not import them (they are
  collection-specific) but should extract the shared frontmatter parse/mutate into a pure
  `src/shared/` module both can use.
- The canvas knows two node types (`nodeTypes` in `src/renderer/src/App.tsx`, `CanvasNode` union
  in `canvas-workspace.ts`). Adding a third and fourth follows the worktree precedent:
  serialize/restore functions in `canvas-workspace.ts`, an optional array on `WorkspaceState`,
  validator support in `workspace-store.ts`, a context-menu entry.
- Reading a file for the renderer needs a new main-side IPC (`file:read`) with a size cap and a
  change subscription. The renderer has no filesystem access (enforced by dependency-cruiser).
- Markdown rendering is shared: `MarkdownMessage.tsx` exports `markdownBlockComponents` and
  `remarkPlugins`; `BrainDumpReader.tsx` shows how a non-transcript surface reuses them. Code
  highlighting is `syntax-highlight.tsx` over lowlight.
- Diff rendering exists in `file-operation.ts` (`diffLines` from the `diff` package, the only
  allowed npm import for that module) and `FileOperationCard.tsx`. A diff node should feed git
  output into the same block model rather than a second renderer.
- `git-worktree.ts` already runs git with `hiddenProcessOptions` and reports
  `changedFiles`/`ahead`/`behind` per worktree; a `diff` method belongs on the same manager.
- Chat transcripts expose file operations per activity (`fileOperationFor`), which is how the
  board can tell that a session is currently working on a ticket file.

## Tickets

| Issue | Slice | Blocked by |
| --- | --- | --- |
| #142 | Ticket file convention and `tickets` skill | — |
| #145 | Ticket board panel for the active project | #142 |
| #146 | Live session cards on the ticket board | #145 |
| #147 | GitHub issues as a second ticket source | #145 (backlog) |
| #143 | File node: read a file on the canvas | — |
| #144 | Diff node: review a worktree's changes | — |
| #148 | Editing inside the file node | #143 |
| #149 | Delete tickets that are no longer needed | #145 (backlog) |
