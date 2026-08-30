---
name: brain-dump
description: Organize raw ADE brain dumps into a persistent, one-file-per-topic Markdown archive. Use when the user shares unstructured ADE ideas, feature thoughts, decisions, concerns, or notes that need to be sorted into new and existing topics.
---

# Brain Dump

Turn the user's raw input into an evolving ADE idea archive at `docs/brain-dumps/`, relative to the repository root. This skill is ADE-only; if the current workspace is not the ADE repository containing this skill, stop and explain that boundary.

## File the dump

1. Read every existing Markdown file in `docs/brain-dumps/` before classifying the new material. Treat a missing directory as an empty archive and create it when the first topic is written.
2. Break the dump into substantive fragments, then cluster them by durable subject. Match a cluster to an existing topic by meaning and intent, not merely shared wording. Keep independently useful ideas in separate files.
3. Account for every substantive fragment. Give each fragment one primary topic; connect related topics with Markdown links instead of copying the same material into several files.
4. Create one lowercase kebab-case `.md` file for each genuinely new topic. Keep an existing filename stable unless renaming or consolidating is necessary to restore one canonical file per topic.
5. Rewrite each affected file as a coherent current-state summary that incorporates both its previous content and the new material. Integrate and deduplicate; do not append a chronological dump log.

## Topic file shape

Start each file with:

```markdown
---
title: Human-readable topic name
created: YYYY-MM-DD
updated: YYYY-MM-DD
---

# Human-readable topic name

A concise orientation to the topic and why it matters to ADE.
```

After the introduction, use only the sections the topic needs. Useful sections include `Current understanding`, `Decisions`, `Possibilities`, `Constraints`, `Open questions`, `Risks and tensions`, and `Related topics`. Prefer clear prose and compact bullets over a rigid template.

Preserve concrete details, examples, rationale, names, and constraints while removing repetition and conversational filler. Treat explicit corrections or decisions as the new current state. When the dump is ambiguous or conflicts with archived material, retain the competing information under an open question or tension rather than inventing a resolution.

## Completion

Before responding, verify that every substantive input fragment is represented, no unrelated topics were collapsed together, links resolve to the intended topic files, and each changed file reads as one polished summary.

Return only a compact change report in chat:

```text
Created 4 topics (A, B, C, D). Added information to 2 topics (E, F).
```

Omit a clause whose count is zero. If nothing changed, say `No topic files changed.`
