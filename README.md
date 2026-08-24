# ADE canvas terminal foundation

> **FOUNDATION MILESTONE.** ADE is still a Windows-first prototype, but its working canvas, persistence, resumable sessions, and packaging path are now protected as a stable baseline for continued experiments.

Windows-only for this prototype. Projects and canvas nodes are saved locally. PTY processes end with ADE, while Claude and Codex conversations can be resumed from restored nodes.

## ACP chat nodes

ADE uses one provider-neutral chat node for both Codex and Claude. It uses stable ACP v1 with pinned `codex-acp` and `claude-agent-acp` adapters; ordinary terminal nodes continue to use the existing PTY/xterm implementation.

Run `npm run dev`, right-click the canvas, and create a **Codex** or **Claude** node. If the provider is not already authenticated, choose its subscription login from the node. No prompt is sent during sign-in.

Agent nodes use a flowing chat layout with clearly separated user and assistant messages. A worklog beside the conversation shows plans, commands, edits, and other tool activity. Collapse it to a narrow tab when the conversation needs more room, then reopen it without resizing the node.

## FirstMate dock

ADE has one persistent FirstMate dock on the right side of the workspace, with independent Codex and Claude captain tabs: only the active tab's captain runs, and switching tabs is blocked while that captain is starting or working. Each tab's conversation is ADE-wide, and every request includes a machine-readable catalog of the sidebar projects. The project currently selected in the left sidebar is shown as a hint, but FirstMate can resolve the request to another catalog project or dispatch separate tasks to several projects. Each dispatched task receives the durable project and provider context for the catalog entry FirstMate selected; later sidebar or provider changes cannot retarget it. If a project match is missing or ambiguous, FirstMate asks for clarification and launches no crew. On Windows, choose **Set up in Ubuntu** once: ADE provisions a private FirstMate distro, operational `FM_HOME`, Linux Codex ACP runner, tmux backend, Treehouse, and FirstMate's supported toolchain inside the user's Ubuntu WSL home. None of these files are stored in an ADE project or in Docker Desktop's internal distribution.

Sidebar projects stay where they are. When a request is sent, ADE validates and registers the catalog projects as durable external projects: it records stable identity, canonical Windows and WSL paths, Git origin classification, delivery posture, and autonomy policy in its own registration file inside the private FirstMate home, and restores those mappings on restart. A project with a remote defaults to FirstMate's `no-mistakes-prod-only` standing posture, a project without one defaults to `local-only`, and autonomy stays off until the captain asks for it. The dock shows the active hint's registered posture. Two projects with the same folder name stay distinct, and ADE never clones or links a checkout into FirstMate's managed `projects` directory.

FirstMate's own fleet registry stays FirstMate's. ADE only reads it: an entry the captain recorded there for one of these checkouts outranks the posture ADE resolved, and adding an entry remains the captain's own project intake. Selecting a project never changes it either — the one-time no-mistakes gate setup that writes inside a checkout waits in the dock for an explicit **Authorize gate setup**, and removing a project from the sidebar retires only ADE's registration.

The active tab uses the same ACP transport as its provider's canvas nodes. Each provider's conversation ID, selected model, thinking effort, and permission mode are saved independently in the ADE workspace and restored on restart; worklog layout applies dock-wide. Authentication and tool approvals stay visible in the dock.

When a captain asks a labeled multiple-choice question, ADE keeps that finalized decision pinned above the composer with clickable choices and an **Other** field. Pins remain scoped to their captain tab and task, support several open decisions at once, and disappear when answered or when the task closes without removing the conversation transcript. Answers use the normal prompt queue, including while the captain is working.

FirstMate officially supports macOS and Linux. ADE remains a native Windows application and bridges its FirstMate ACP process over stdio through `wsl.exe`; FirstMate and its workers stay inside Ubuntu. The verified tmux reference backend is selected explicitly. ADE installs native Linux Claude and Codex CLIs, gives each provider its own credentials, and explicitly configures no-mistakes to use the provider selected for FirstMate. ADE checks the complete managed runtime before enabling the dock and can repair missing packages idempotently without asking for the Linux sudo password.

The two account grants remain interactive by design. The dock opens GitHub's `gh auth login` flow in Windows Terminal and detects its completion automatically. The existing ACP authentication panel handles Codex ChatGPT, device-code, or API-key sign-in. ADE never reads or copies either credential.

## Run

```powershell
npm install
npm run dev
```

## Verify

```powershell
npm run typecheck
npm test
npm run build
```

The tests exercise behavior through the workspace, provider, terminal-lifecycle, and canvas-persistence interfaces. They use temporary local files and do not invoke Claude or Codex.

## Package for Windows

```powershell
npm run package:win
```

This creates the x64 portable executable at `dist/ADE-0.1.0-portable-x64.exe`. It needs no installer. The current prototype uses Electron's default icon and is not digitally signed, so Windows may display an unfamiliar-app warning.

## Architecture

- `src/main/index.ts` composes the application and wires Electron IPC.
- `src/main/workspace-store.ts` owns workspace validation, migration, loading, and saving behind one store interface.
- `src/main/session-providers.ts` hides Claude/Codex launch arguments, session discovery, transcript lookup, and preview parsing behind one provider interface.
- `src/main/terminal-manager.ts` owns PTY processes, renderer ownership, Codex discovery polling, and shutdown behavior behind one lifecycle interface.
- `src/renderer/src/canvas-workspace.ts` converts between persisted workspace nodes and live canvas nodes.

`node-pty` 1.1.0 ships Windows x64 prebuilt native binaries, which are unpacked from the application archive. Packaging intentionally skips a source rebuild so contributors do not need Python and Visual Studio Build Tools merely to produce this Windows prototype.

The current folder starts as the first project. Use **Add project** in the left sidebar to choose more folders, then click a project to make it the creation target. All projects remain visible on one canvas. Right-click the canvas and choose **Terminal**, **Claude**, or **Codex**; the session starts in the selected project's folder and carries a project badge. Terminal nodes expose the native shell, while Claude and Codex nodes share the ACP chat prototype.

Projects, their colors, the active creation target, sidebar state, and terminal-node geometry are automatically saved to `prototype-workspace.json` in Electron's user-data folder. Empty projects can be removed from the sidebar; delete their nodes first when necessary.

After restarting ADE, saved nodes appear dormant. **Resume conversation** continues the matching Claude or Codex chat using the provider's locally saved session. Plain terminal nodes reopen a fresh shell in the same project folder. Until a process owner reconnects, a terminal whose exit was not previously confirmed is marked **Unverifiable**, not **Exited**.

Dormant agent nodes show locally cached excerpts of the latest user and assistant messages. ADE reads these from the providers' existing transcript files after terminal output settles; generating the preview does not call a model or consume tokens.

The number beside a project is its live node count. Click it to bring that project's nodes into view. Each project also lists its assigned sessions. Clicking a session focuses its node on the canvas. An unfocused session that finishes a burst of output is marked **Attention** until you focus or interact with it. Terminal liveness is shown separately as **Live**, **Unverifiable**, or **Exited**; only a process-owner exit report establishes **Exited**.

Select terminal text with the mouse and use **Ctrl+Shift+C** (or the node's **Copy** button) to copy it. Use **Ctrl+Shift+V** to paste. The traditional **Ctrl+Insert** and **Shift+Insert** shortcuts work too.

## Deliberately excluded

- Live PTY process restore
- Mobile and remote access
- Authentication
- Agent orchestration and worktrees
- Project reordering
- Canvas edges, groups, and editors

The renderer talks to PTYs only through a narrow preload API. That is the sole forward-looking seam retained so a later implementation can replace local IPC with a remote transport without rewriting the canvas.
