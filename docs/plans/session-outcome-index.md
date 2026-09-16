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

The pointer itself costs ~930 characters (~235 tokens) on every session, read or not (grown from ~740 by #197's retrieval-pattern sentence). That is the fixed price of the index being discoverable at all, and it is one file-read's worth.

### A capped file list says it is capped (#198)

Truncation without a marker is the same silent false negative as #197's pattern, one layer down: the file list is what a later session trusts to answer "has anything already touched this area?", and a list that stops at `SESSION_OUTCOME_FILES_LIMIT` with nothing to show for it answers "no" for a file the conversation in fact rewrote. A record at exactly the cap was indistinguishable from a complete one — observed against the real index on 2026-09-16.

A truncated list now ends on one more item, `- … and at least N older files omitted` (`sessionOutcomeFilesOmittedMarker`), counted against `SESSION_OUTCOME_SIZE_BUDGET` like any other line and recognised on the way back in so the parser never reads it as a path. The newest writes are the ones kept: they are what a later session is asking about, and the oldest are the ones git still names for free once the conversation is identified.

The watch's accumulator is the one deliberate cost: it now holds the session's whole distinct write set rather than sixteen entries, and re-dedupes it at every report. That is what the exactness is bought with — a capped accumulator throws away the paths the count is derived from — and the set is the paths the tool calls already reported, so it is bounded by the work the session actually did rather than by anything the index chose.

**"At least" is not hedging.** The record keeps only the paths it lists, so `filesOmitted` is a floor, taken as `max(what the record already knew, what this merge dropped)`. Within one process it is exact — the watch now accumulates the session's *whole* distinct write set and lets the record apply the cap once, instead of bounding the list twice and throwing away the paths the count is derived from. Across a restart it can only understate, because a resumed session cannot tell whether its writes are files an earlier process already dropped and counted. Understating is the safe direction: the claim the marker makes is "this list is partial", and that is never wrong.

### The taught pattern (#197)

The pointer originally taught "the path is JSON-quoted, so backslashes are doubled", which sends a session grepping for the literal quoted path — and from Bash on Windows that silently returns nothing: the shell mangles backslash runs in arguments before grep sees them (`MSYS_NO_PATHCONV=1` does not rescue it), and "no matches" is indistinguishable from "this project is new", so the session re-derives exactly what the index was holding. Measured against the real index on 2026-09-16: 6 records for this repo, literal-path grep found 0, the dot-wildcard pattern found all 6. The #190 demo run below never caught it because the session happened to grep the temp directory's leaf name, which contains no backslashes.

The pointer now teaches a pattern with **no backslashes at all**: the JSON-quoted `project:` line with a dot per stored backslash, closing quote included — `project: "D:..Development..ADE"` for `D:\Development\ADE`. The quotes and the full-path shape are the selectivity: a same-named leaf under a different root, a sibling sharing the prefix, and the project's own worktrees all fail the match. `sessionOutcomeProjectPattern` in `src/shared/session-outcome.ts` is that recipe in code — it generates the pointer's own worked example, and `tests/session-outcome-retrieval.test.ts` proves it against a record written by the real serializer, so the prose, the pattern and the on-disk format cannot drift apart. The live script now normalizes its throwaway project path to backslashes on win32 (refusing to run vacuously without them) and fails itself when the answer names fewer than two of the three seeded records. Re-run live on 2026-09-16 (Claude): the session greped `project: "C:..Users..user..AppData..Local..Temp..toucan-live-project-wlnV9q"` — the taught pattern verbatim, against a fully backslashed path — read all three records, zero approvals, PASS.

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

## Hygiene (#191)

Two rules keep the index worth reading, and both need something the store cannot see, so both live at the indexer while the policy itself stays pure and shared.

**Trivial conversations leave nothing behind.** No writes and fewer than `SESSION_OUTCOME_TRIVIAL_TURNS` (2) asks is a question the captain could have put to any session — real work, but not work the *next* session needs told about. The record is still written every turn while the conversation runs, because it is what carries `startedAt` and the accumulated write set from turn to turn, and it is dropped at `SessionOutcomeWatch.finalize` instead: the end of the session is the only moment "one ask, nothing written" is a settled verdict. Removal runs on both finalize passes — synchronously, which is the only thing that survives `before-quit`, and again on the queued pass, which re-reads rather than trusting the first, since a capture landing in between may have made the conversation worth keeping.

**The index is capped at `SESSION_OUTCOME_RECORD_CAP` (400) records**, least-recently-updated pruned first. `prunableSessionOutcomes` is pure and decides the order; a record the parser cannot read contributes no timestamp and therefore goes first. Pruning runs only after a record is *created*, which is the only moment the count can grow, and the cheap `store.keys()` listing is what keeps the over-cap directory read to once per new conversation.

A currently-active conversation is never pruned, and "active" here is membership of the indexer's live set — the conversations this process is still watching — not the record's own `status`, which only says no end was observed and so reads the same for a node dormant since last week. Live records still count toward the cap, so an index whose every record is live sits over it until sessions end: a soft cap is the right failure, because pruning a record mid-conversation would cost it exactly the history no transcript can reconstruct. Protection is refcounted per watch rather than per key, since retiring a node and resuming it leave two sessions holding one conversation for a moment and the first release must not speak for the second.

Two residual gaps, both deliberate. The cap is enforced on one edge only — a new record — so an index left over the cap by other means (a lowered cap, records copied in) stays over it until the next new conversation. And a conversation is only protected while *this process* watches it, so a record resumed elsewhere before its first turn boundary is prunable; the cost of losing that race is one conversation re-deriving its record from the transcript, which is what the index does at every boundary anyway.

## Ticket set

1. Tracer bullet: outcome record written at turn end (type + indexer + markdown store, compact by construction).
2. Rich capture: files touched, failures, status.
3. Agent retrieval: outcomes directory via `additionalDirectories` + context pointer; verify the grep path end-to-end. **Landed** — see "Measured retrieval budget" above.
4. Hygiene: pruning and trivial-session filtering. **Landed** — see "Hygiene" above.

Out of scope for this set: LLM summarization, revert detection (needs git correlation), follow-up extraction, stow-skill integration, any UI.
