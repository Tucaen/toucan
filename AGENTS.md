# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- ADE hosts FirstMate only through Windows' WSL host; `createUnsupportedFirstMateRuntime` in `src/main/firstmate-runtime.ts` refuses every other platform, so there is no second host implementation to extend. ADE hosts the FirstMate captain as an ACP conversation, not a tmux pane. `src/renderer/src/firstmate-project-catalog.ts` gives it the machine-readable ADE project catalog and a hint-only active project; FirstMate resolves each task and pins the selected project/provider carrier from `src/shared/firstmate-task-context.ts` at dispatch. Lifecycle, app-native wake, serialized task-scoped validation, and provider/model wrappers are owned by `src/main/firstmate-lifecycle.ts`, `src/main/firstmate-lifecycle-coordinator.ts`, and `src/main/firstmate-runtime.ts`.
- Sidebar projects are durable external FirstMate projects, never clones under FirstMate's managed `projects` directory. `src/main/firstmate-external-projects.ts` owns identity, canonical paths, posture defaults, collisions, and migration, and `src/main/firstmate-project-origin.ts` owns which origins are accepted. Registration writes only ADE's own file in the private home: `data/projects.md` is firstmate-private and rebuilt from the clones under `projects/`, so ADE reads it and lets an entry recorded there for a checkout outrank ADE's own record. Its format and posture vocabulary belong to the managed distro's `bin/fm-project-mode.sh`. Registration only reads a checkout; anything that would write inside one needs a separate explicit authorization.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
