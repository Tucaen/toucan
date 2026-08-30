---
title: Invisible background processes
created: 2026-08-30
updated: 2026-08-30
---

# Invisible background processes

ADE's background process execution must never create transient command windows or steal focus from the user's current activity.

## Current understanding

- Command Prompt windows have been observed appearing for less than a second.
- Even very brief windows are disruptive because they take focus while the user is typing and are especially severe during gaming.
- Preventing visible background-process windows is a hard user-experience constraint, not merely a cosmetic improvement.

## Open questions

- Which process-launch path is creating the visible windows?
- Are all Windows subprocess entry points consistently configured for hidden execution?
- What automated coverage can prevent focus-stealing process launches from returning?

## Related topics

- [Architecture and code quality](architecture-and-code-quality.md)
