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

## Implemented decisions

- ACP `agent_thought_chunk` remains the provider-neutral reasoning signal. Codex commentary and final output use `agent_message_chunk` with `_meta.codex.phase`; unphased assistant text is treated as provisional progress until its turn completes.
- Progress remains expanded and visually subdued. The existing Focus mode hides progress alongside reasoning and tool activity.
- Restored transcripts apply provider phases when present and otherwise reconstruct turn boundaries from user messages, promoting only the last unphased assistant message in each turn to final.
