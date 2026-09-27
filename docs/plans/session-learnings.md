---
title: Session learnings plan
created: 2026-09-27
updated: 2026-09-27
status: proposed - stage 1 only
---

# Session learnings

The outcome index records _what happened_ in a conversation. Learnings record _what to do differently next time_: short, imperative, per-project lessons that every later session gets without having to read through old records to find them. The idea comes from LifeOS (`danielmiessler/LifeOS`): its `SessionHarvester`, `LearningPatternSynthesis.ts` (recurrence floors, capped hypotheses that expire) and `memory-proposals.ts` (a proposal queue with accept / reject / edit). This plan fits that idea to Toucan's rules instead of copying LifeOS's autonomic loop.

## Motivation

A later session that reads the index can see that an earlier one failed. It cannot see that three earlier ones hit the _same_ wall, and it pays a read to find out even once. A lesson is that pattern turned into one line, cheap enough to include in every session.

## What the index can support today (measured 2026-09-27, 82 records)

- **`## Failures` is almost empty.** It records only turn boundaries that ended `failed` or `cancelled`. One of 82 records has the section, and its message is `Internal error`. Failed commands, red tests and abandoned approaches are not captured at all, even though every tool call's `status` (`AgentActivity.status`, including `'failed'`) already sits in the `AgentTranscriptState.activities` snapshot the indexer reads.
- **`## Asks` is too new to measure.** It landed with #19 on 2026-09-25, and only 2 records carry it yet. Corrections ("no, not like that", "still broken", "revert that") would show up there, but there is no corpus to tune a detector against.
- **The judgment is squeezed out**, as `session-outcome-index.md` already records under "What extraction cannot reach".

So the first stage is better signal, not distillation, and distillation waits until the signal has been measured against a real index.

## Pipeline

1. **Signal capture (zero tokens, indexer).** Records gain a capped `## Tool failures` section, built from failed tool activity in the snapshot. Corrections are _not_ captured separately, because `## Asks` already holds the text and a second copy would spend the record budget twice. Stage 2 reads them from there. Revert detection stays out of scope: it needs git correlation, the same reason the outcome index deferred it.
2. **Recurrence (zero tokens, pure rule in `src/shared`).** Across one project's records, cluster tool failures by normalized command or title and by file area, and asks by correction phrasing. A cluster becomes a candidate at **2 or more distinct conversations** (LifeOS's `HEALING_RECURRENCE_THRESHOLD`). A one-off never becomes a lesson.
3. **Distillation (tokens, gated).** A background agent turn in the brain-dump-capture pattern (`brain-dump-capture.ts`) runs a `distill-learnings` skill over a candidate's records, and transcript excerpts where needed. It emits **proposals**, never lessons: `lesson` (one imperative line), `evidence` (record keys plus `commit`), `scope` (project | global) and `target` (lessons file | `AGENTS.md`).
4. **Review and injection.** No proposal applies itself. Accepted lessons go to `<userData>\session-learnings\<project-slug>.md` under a hard cap (≈1.5 KB, ≈10 lessons) and are **inlined** into the session instruction beside the outcome-index pointer. Every session pays for that file, so the cap is the design constraint, the same way the pointer's cost was (#190). A lesson not re-observed for 60 days is re-checked against `git log <commit>..HEAD`, the same freshness rule old failures follow. A lesson that belongs with the code can be promoted into an `AGENTS.md` edit as an explicit step.

## Open decisions (before stage 3)

- **Model spend.** Stage 3 is the first part of session memory that is not free. Leaning: user-triggered only, like brain-dump capture, not autonomous.
- **Review surface.** The outcome index is "no UI, ever" (owner decision 2026-09-13), but approving proposals needs a place to happen. Options: a list in the brain-dump panel, or a chat ("review pending lessons") that keeps the no-UI rule.
- **Where lessons live.** Leaning: userData, matching "nothing lands in checkouts", with promotion to `AGENTS.md` as an explicit step.

## Stage 1: `## Tool failures` in outcome records

Decisions:

- **Source is the snapshot, not a new broker hook.** Failed tool activity is already in `AgentTranscriptState.activities` (`status: 'failed'`). Extraction is a pure function in `src/shared/session-outcome.ts` beside `boundedFailures`, so it needs no new plumbing in `acp-session-manager.ts`.
- **An entry is the tool's title plus a one-line error excerpt.** Prefer the activity's `content`. For a shell call, use the exit code from `rawOutput` when present, parsed defensively like `file-operation.ts`. Fall back to the title alone. Entries are deduplicated by title plus excerpt, because agents retry the same failing command.
- **Capped, and says so.** Newest entries are kept, under a count cap and a per-entry character cap in the spirit of `SESSION_OUTCOME_FAILURE_LIMIT` / `SESSION_OUTCOME_FAILURE_MESSAGE_LIMIT`, with an omission marker that the parser recognises (the #198 rule).
- **Inside the existing ceiling.** The section counts against `SESSION_OUTCOME_SIZE_BUDGET` (6144). The saturated case in `tests/session-outcome-retrieval.test.ts` must still fit, and `## Main result` keeps its role as the section that yields space.
- **Survives a restart.** The section is read back and merged at the next capture, as `## Failures` is, because a resumed process may not replay earlier activity.
- **Taught.** `sessionOutcomeIndexInstruction` lists the new section, and the pointer's measured cost in `session-outcome-index.md` is updated.

After stage 1 ships, let the index fill for one to two weeks, then measure how many records carry tool failures, how many clusters cross the threshold, and how noisy correction phrasing in `## Asks` is. Stage 2 is specified from those numbers.
