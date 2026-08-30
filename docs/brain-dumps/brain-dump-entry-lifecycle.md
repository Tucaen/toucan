---
title: Brain-dump entry lifecycle
created: 2026-08-30
updated: 2026-08-30
---

# Brain-dump entry lifecycle

Brain-dump entries need a lifecycle beyond "captured". Once an idea has been acted on, the user must be able to mark it as resolved or implemented so the active archive reflects only what is still open.

## Current understanding

- Topic files in `docs/brain-dumps/` currently have no status; every entry looks equally live regardless of whether it has already been built or otherwise settled.
- The user needs a way to mark an entry as resolved, implemented, or a similar terminal state.
- Completed entries should move into some form of archive rather than being deleted permanently, so the history of what was thought and why remains recoverable.

## Decisions

- Permanent deletion is not the desired behaviour for finished entries; archiving is preferred.

## Open questions

- What is the exact set of terminal states? "Resolved" and "implemented" were both named as examples, alongside an open-ended "or whatever" — it is not yet settled whether one generic done state suffices or distinct outcomes (implemented, resolved, obsolete, rejected) are worth tracking separately.
- How is the archive represented: frontmatter status on the existing file, a subdirectory such as `docs/brain-dumps/archive/`, or another mechanism?
- Should archived entries stay linkable from active topics, and should their inbound Markdown links keep resolving after a move?
- Can a whole topic file be archived, or does the status apply to individual ideas within a topic? Topic files are coherent summaries that may mix implemented and still-open material.
- Should the brain-dump skill itself avoid folding new material into an archived topic, or reopen it instead?
- Who sets the status — the user through a UI, the skill during a dump, or automatically when related work merges?

## Related topics

- [Brain-dump library UI](brain-dump-library-ui.md)
