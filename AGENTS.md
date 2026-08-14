# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- ADE hosts the FirstMate captain as an ACP conversation, not a tmux pane. The durable task lifecycle, app-native wake path, and structured validator configuration are owned by `src/main/firstmate-lifecycle.ts`, `src/main/firstmate-lifecycle-coordinator.ts`, and `src/main/firstmate-runtime.ts`.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
