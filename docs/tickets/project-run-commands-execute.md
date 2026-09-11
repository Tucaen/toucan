---
title: Run a saved project command from the project context menu
status: open
created: 2026-09-11
updated: 2026-09-11
blocked_by: project-run-commands-config
---

Starting a project is a many-times-a-day action, so it must not require opening the settings dialog. The project row in the sidebar already has a context menu; add a "Run" section to it listing the project's saved commands by name.

Choosing an entry spawns a new terminal node on the canvas, anchored at the project's checkout path, and feeds it the command — the same visible-terminal pattern the worktree setup command uses, so failures, prompts and long-running processes can be seen and interrupted. Each click spawns its own terminal node; running "Web" and "API" for a multi-part project is two clicks producing two nodes.

Projects with no saved commands show no "Run" section (or a disabled hint), not an empty submenu.

Done means:

- Right-click a project row → pick a saved command → a terminal node appears running it in the project checkout.
- Multiple commands can run concurrently as separate terminal nodes.
- Covered by tests alongside the existing project-panel tests.

Deferred deliberately (not in this ticket): a "run all" / launch group that starts several commands with one click — add only if per-command clicks prove annoying.
