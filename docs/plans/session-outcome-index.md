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

## Measured retrieval budget (#190)

Capture being free is only half the bargain; the read has to be cheap enough that consulting the index beats re-deriving. Measured over a screenful (`SESSION_OUTCOME_SCREENFUL`, 20 records — `tests/session-outcome-retrieval.test.ts` holds these numbers):

| What | One record | A screenful of 20 | ≈ tokens |
| --- | --- | --- | --- |
| Typical (real ask, real answer, 8 files, one failure) | 1.1 KB | 21.6 KB | ~5.4k |
| Frontmatter only — stage one of the read | 0.26 KB | 5.3 KB | ~1.3k |
| Saturated — every cap filled at once | 3.5 KB | 69.5 KB | ~17k |

Two things follow. The caps the tracer bullet wrote were too loose for the saturated case, so they were tightened here: `SESSION_OUTCOME_FILES_LIMIT` 24 → 16, `SESSION_OUTCOME_PATH_LIMIT` 100 → 80, and the per-record ceiling `SESSION_OUTCOME_SIZE_BUDGET` 5120 → 4096. And the pointer teaches a **two-stage read** — grep `project:` to name the files, then open only the records worth reading — which is what keeps the common case at stage one's price rather than stage two's.

The pointer itself costs ~740 characters (~185 tokens) on every session, read or not. That is the fixed price of the index being discoverable at all, and it is one file-read's worth.

### The demo run

`node scripts/verify-outcome-retrieval.mjs claude` (not part of `npm test` — it launches a real adapter and spends account tokens) puts a real session in a throwaway project it has never seen, beside a throwaway outcomes directory holding three records, and asks the retrieval question. Captured verbatim, 2026-09-13:

```
session: ready
prompt: accepted

===== ANSWER =====
Three prior sessions, all on 2026-09-11:

1. **Upload queue retry** — added exponential backoff in `src/upload/queue.ts`. A worker-thread
   approach was tried and abandoned: the queue shares one socket, so a second thread just
   relocated the contention.
2. **Thumbnail caching** — disk cache under userData (`src/media/thumbnail-cache.ts`). Eviction
   policy deliberately omitted since nothing measures cache size yet.
3. **Settings dialog off React context** — reverted. The context wasn't the cost; the canvas was
   re-rendering on every pointer move (still unfixed, as far as the record shows).

===== TOOL CALLS =====
- grep -l "toucan-live-project-J9FX9j" C:\Users\...\Temp\toucan-live-outcomes-MVmzbU
- Read C:\Users\...\Temp\toucan-live-outcomes-MVmzbU\claude-aaa-0001.md
- Read C:\Users\...\Temp\toucan-live-outcomes-MVmzbU\claude-aaa-0002.md
- Read C:\Users\...\Temp\toucan-live-outcomes-MVmzbU\claude-aaa-0003.md

approvals asked: 0
```

Three things in it are the point. **Zero approvals** — the sandbox grant works, unprompted. The session ran the **two-stage read the pointer teaches** without being told to: one `grep -l` for the project path, then three reads. And the answer carries what only the index knows — an approach that was abandoned and *why*, a deliberate omission, and a change that was reverted — which is exactly the re-derivation the index exists to prevent.

The Codex leg is covered by tests (`session/new` carries the directory, `CODEX_CONFIG` carries the pointer) but **not yet by a live run**: the account hit its usage limit mid-verification. Codex's is the sandbox that would actually refuse the read, so that run is still owed.

## Ticket set

1. Tracer bullet: outcome record written at turn end (type + indexer + markdown store, compact by construction).
2. Rich capture: files touched, failures, status.
3. Agent retrieval: outcomes directory via `additionalDirectories` + context pointer; verify the grep path end-to-end. **Landed** — see "Measured retrieval budget" above.
4. Hygiene: pruning and trivial-session filtering.

Out of scope for this set: LLM summarization, revert detection (needs git correlation), follow-up extraction, stow-skill integration, any UI.
