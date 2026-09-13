# Session outcome index

A persistent, structured record of what each agent conversation actually did — task, approach, files touched, result, failures — queryable by later sessions so they stop re-deriving context and re-exploring dead ends.

## Motivation

Git history says *what* changed, not *why the other approach was rejected*. Provider transcripts are heavyweight, directory-scoped, and expensive to re-read. Toucan already sits at the seam where every agent event flows through main, so it can extract an outcome record for free.

## Decisions

- **Zero LLM tokens for capture.** The record is deterministic *extraction* from the transcript snapshot (first user message → task, final assistant message of the latest turn → last result, plus mechanically derived facts), following the repo's stated bias toward zero-token derivation (see `conversation-title.ts`). Model-generated summaries are an explicit future upgrade via the brain-dump-capture pattern (user-triggered background agent turn), not part of v1.
- **Capture happens in main, per turn, at the agent event broker.** The broker's turn-boundary events (`turn_complete` / `turn_failed` / `turn_cancelled`) plus its per-session transcript snapshot give everything needed with no renderer involvement — phone-driven turns are covered too. Sessions outlive processes (dormant nodes get resumed), so end-of-turn is the reliable boundary; end-of-session only finalizes status.
- **Keyed by `(provider, conversationId)`**, mirroring the conversation-title store — conversations outlive canvas nodes. Node id, project path, worktree id are denormalized attributes.
- **Storage is a Markdown-with-frontmatter library** under `<userData>\session-outcomes\`, one file per conversation, brain-dump-library shape, durable-write primitives. Not SQLite, deliberately: the primary querier is an *agent* reading with grep over an `additionalDirectories`-sandboxed folder; SQL would add a native module and a tool round-trip per query for no gain at capped scale (hundreds of records). Migration later is trivial if scale demands it.
- **No UI, ever** (owner decision 2026-09-13): humans ask an agent to retrieve; no renderer IPC surface, no browsable panel.
- **Retrieval token budget is a first-class constraint.** Zero-cost capture is worthless if reading the index is expensive. Records carry hard caps on excerpt length and compact frontmatter, written that way from day one.
- **Files-touched is accumulated by the indexer itself** from the same signal that feeds `recordWrittenLocations`, not read from the 100-entry `recentWrites` ring, which is lossy for long sessions.
- **Global store, not per-project.** Records live under userData with `projectPath` in frontmatter; nothing lands in checkouts; agents filter by project when reading; cross-project queries stay possible.
- **Hygiene keeps signal high:** LRU-prune by `updatedAt` past a file-count cap; skip trivial conversations (no writes, fewer than 2 turns).

## Ticket set

1. Tracer bullet: outcome record written at turn end (type + indexer + markdown store, compact by construction).
2. Rich capture: files touched, failures, status.
3. Agent retrieval: outcomes directory via `additionalDirectories` + context pointer; verify the grep path end-to-end.
4. Hygiene: pruning and trivial-session filtering.

Out of scope for this set: LLM summarization, revert detection (needs git correlation), follow-up extraction, stow-skill integration, any UI.
