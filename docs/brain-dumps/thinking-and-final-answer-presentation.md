---
title: Thinking and final-answer presentation
created: 2026-08-30
updated: 2026-08-30
---

# Thinking and final-answer presentation

ADE's chat should visually distinguish an agent's interim thinking or progress messages from its actual final answer, so users can immediately tell what is process narration and what is the completed result.

## Current understanding

- Thinking messages currently appear like the final result in chat.
- Interim messages such as announcing use of the brain-dump skill, explaining that the archive is being read, and reporting the four identified topic clusters should be presented as thinking or progress.
- In that example, only `Created 4 topics (Mobile session access, Architecture and code quality, Invisible background processes, Brain-dump library UI).` is the final answer.
- The visual treatment must make this distinction clear without discarding useful progress context.

## Open questions

- Which underlying ACP update types reliably identify thinking, progress commentary, reasoning, and final assistant output across providers?
- Should thinking remain expanded, collapse after completion, or follow the node's existing focus-mode behavior?
- How should restored transcripts preserve the same distinction?
