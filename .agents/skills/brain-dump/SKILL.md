---
name: brain-dump
description: Organize raw ADE brain dumps into a persistent, one-file-per-topic Markdown archive. Use when the user shares unstructured ADE ideas, feature thoughts, decisions, concerns, or notes that need to be sorted into new and existing topics.
---

# Brain Dump

Turn the user's raw input into an evolving ADE idea library rooted at `ADE_BRAIN_DUMPS_DIR`. This skill is ADE-only; if the current workspace is not the ADE repository containing this skill, stop and explain that boundary. If `ADE_BRAIN_DUMPS_DIR` is absent, stop and explain that ADE must launch the agent with the library location; never fall back to `docs/brain-dumps/`.

## File the dump

1. Read every direct Markdown child of `$ADE_BRAIN_DUMPS_DIR/active/` before classifying new material. Treat a missing active directory as empty and create it when the first topic is written.
2. Consult `$ADE_BRAIN_DUMPS_DIR/archived/` only when no active topic adequately matches or the user explicitly asks about archived material. Archived files are immutable snapshots of a closed scope: never move, rename, or rewrite one while filing a dump, and never create an active duplicate of its slug.
3. When new material relates to an archived topic, create a distinct active follow-up instead of reopening it. Give the follow-up a scope-specific slug, link visibly to the archived topic with `[[archived-slug]]`, and make the implementation boundary explicit under `New work`. Include only the minimum inherited context and constraints needed to act on that new scope; do not copy the archived summary wholesale. If the user is reviving the archived proposal unchanged, state that explicitly under `New work` so the active file still identifies what is actionable now.
4. Break the dump into substantive fragments, then cluster them by durable subject. Match a cluster to an existing active topic by meaning and intent, not merely shared wording. Keep independently useful ideas in separate files.
5. Account for every substantive fragment. Give each fragment one primary topic; connect related topics with `[[slug]]` references instead of copying the same material into several files. Never generate filesystem links between brain-dump topics.
6. Create one lowercase kebab-case `.md` file for each genuinely new topic. Keep an existing slug stable. When the prompt supplies an explicit project association, add its normalized absolute path as `project` on each new topic created from that capture. Preserve an existing matching topic's `project` value unless the user explicitly changes that association. Treat an explicit `unassigned` association as absence of the field; infer no association from words in the dump.
7. Rewrite each affected active file as a coherent current-state summary that incorporates both its previous content and the new material. Integrate and deduplicate; do not append a chronological dump log. Preserve every existing `[[slug]]` reference while rewriting.
8. Archive an entire topic only on explicit user instruction, never from inferred completion. Move it to `archived/`, update `updated`, and add the requested valid `outcome` and `archived` date. Once archived, it remains unchanged; later work belongs in an active follow-up.

## Topic file shape

Start each file with:

```markdown
---
title: Human-readable topic name
created: YYYY-MM-DD
updated: YYYY-MM-DD
project: "D:\\absolute\\project-path"
---

# Human-readable topic name

A concise orientation to the topic and why it matters to ADE.
```

Omit `project` for an unassigned topic. Quote Windows paths and escape each backslash as YAML requires.

After the introduction, use only the sections the topic needs. Useful sections include `New work` for an archived-topic follow-up, plus `Current understanding`, `Decisions`, `Possibilities`, `Constraints`, `Open questions`, `Risks and tensions`, and `Related topics`. Prefer clear prose and compact bullets over a rigid template.

Preserve concrete details, examples, rationale, names, and constraints while removing repetition and conversational filler. Treat explicit corrections or decisions as the new current state. When the dump is ambiguous or conflicts with archived material, retain the competing information under an open question or tension rather than inventing a resolution.

## Completion

Before responding, verify that every substantive input fragment is represented, no unrelated topics were collapsed together, `[[slug]]` links resolve to the intended active or archived topic, and each changed file reads as one polished summary.

Return only a compact change report in chat:

```text
Created 4 topics (A, B, C, D; D follows archived topic G). Updated 2 topics (E, F). Archived 1 topic (H).
```

Omit a clause whose count is zero. If nothing changed, say `No topic files changed.`
