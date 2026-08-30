---
title: Worktree removal progress feedback
created: 2026-08-30
updated: 2026-08-30
---

# Worktree removal progress feedback

Removing a worktree should provide immediate, visible feedback so the user knows the request is being processed and cannot accidentally submit it again.

## Current understanding

- After the user selects **Remove**, the interface currently appears to do nothing while removal is in progress; the worktree then disappears suddenly when the operation completes.
- The **Remove** button should enter an in-progress state immediately and be disabled until the operation succeeds or fails.
- A loading indicator on or near the button would make the ongoing operation clearer, but disabling the button is the minimum acceptable behavior.

## Open questions

- Should the button label change to **Removing...**, display a spinner, or use both treatments?
- If removal fails, how should the dialog restore its actionable state and surface the error?
