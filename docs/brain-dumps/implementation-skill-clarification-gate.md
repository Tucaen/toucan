---
title: Implementation skill clarification gate
created: 2026-08-30
updated: 2026-08-30
---

# Implementation skill clarification gate

The implement-in-worktree workflow should explicitly resolve meaningful ambiguity before it begins implementation, while still establishing the isolated workspace promptly.

## Current understanding

- The current skill settles or creates the worktree and then proceeds directly to implementation.
- It explicitly asks the user a question only when the target base branch is unknown; it does not currently require a general clarification pass for unclear requirements.
- When the requested work contains material ambiguity, the skill should ask clarifying questions rather than silently choose an interpretation.

## Decisions

- The preferred clarification checkpoint is after the worktree has been settled or created and before implementation begins.

## Open questions

- What threshold distinguishes a harmless implementation assumption from ambiguity that must be raised with the user?
- Should the skill summarize its understanding and proposed acceptance criteria even when it has no questions?

## Related topics

- [Architecture and code quality](architecture-and-code-quality.md)
