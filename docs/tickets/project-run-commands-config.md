---
title: Configure named run commands per project
status: done
created: 2026-09-11
updated: 2026-09-11
---

Most projects are started by one or more terminal commands ("API (watch)", "API (debug)", "Web", …). Toucan should let the user save these per project.

Extend the project settings dialog (behind the gear on the sidebar row, next to the existing worktree setup command and tickets folder) with a list of named run commands. Each entry is a display name plus the command line. Entries can be added, edited, removed and reordered. The list persists with the project in the workspace, survives a restart, and an empty list stays the default.

Decision already made: the project avatar keeps its current meaning (select project) — commands are configured here, not triggered from the avatar.

Done means:

- A project can hold any number of named commands, edited in the settings dialog.
- Saved commands reappear when the dialog is reopened and after an app restart.
- The gear's "configured" indicator also lights up when commands exist.
- Covered by tests alongside the existing project-settings tests.
