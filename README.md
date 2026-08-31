# ADE canvas terminal foundation

> **FOUNDATION MILESTONE.** ADE is still a Windows-first prototype, but its working canvas, persistence, resumable sessions, and packaging path are now protected as a stable baseline for continued experiments.

Windows-only for this prototype. Projects and canvas nodes are saved locally. PTY processes end with ADE, while Claude and Codex conversations can be resumed from restored nodes.

## ACP chat nodes

ADE uses one provider-neutral chat node for both Codex and Claude. It uses stable ACP v1 with pinned `codex-acp` and `claude-agent-acp` adapters; ordinary terminal nodes continue to use the existing PTY/xterm implementation.

Run `npm run dev`, right-click the canvas, and create a **Codex** or **Claude** node. If the provider is not already authenticated, choose its subscription login from the node. No prompt is sent during sign-in.

Agent nodes use a flowing chat layout with clearly separated user and assistant messages. A worklog beside the conversation shows plans, commands, edits, and other tool activity. Collapse it to a narrow tab when the conversation needs more room, then reopen it without resizing the node.

## Run

```powershell
npm install
npm run dev
```

## Verify

```powershell
npm run check
```

`npm run check` is the required pre-handoff gate. It checks formatting without modifying files, runs typed ESLint and architecture dependency rules, performs strict typechecking, and runs both the Node and DOM test suites. The tests exercise behavior through the workspace, provider, terminal-lifecycle, and canvas-persistence interfaces. They use temporary local files and do not invoke Claude or Codex.

During iteration, use `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm test`, or `npm run test:dom` for focused feedback. Run `npm run check:full` when changing packaging or the bundled voice model; it adds voice-model verification and a production build to the standard gate.

## Package for Windows

```powershell
npm run package:win
```

This creates the x64 portable executable at `dist/ADE-0.1.0-portable-x64.exe`. It needs no installer. The current prototype uses Electron's default icon and is not digitally signed, so Windows may display an unfamiliar-app warning.

## Architecture

ADE is an Electron application with a privileged main process, a narrow context-isolated
preload seam, and a React renderer. Shared modules hold cross-process contracts and pure
domain rules. See [the architecture map](docs/architecture.md) for module ownership,
dependency direction, important seams, and representative verification paths.

`node-pty` 1.1.0 ships Windows x64 prebuilt native binaries, which are unpacked from the application archive. Packaging intentionally skips a source rebuild so contributors do not need Python and Visual Studio Build Tools merely to produce this Windows prototype.

The current folder starts as the first project. Use **Add project** in the left sidebar to choose more folders, then click a project to make it the creation target. All projects remain visible on one canvas. Right-click the canvas and choose **Terminal**, **Claude**, or **Codex**; the session starts in the selected project's folder and carries a project badge. Terminal nodes expose the native shell, while Claude and Codex nodes share the ACP chat prototype.

Projects, their colors, the active creation target, sidebar state, and terminal-node geometry are automatically saved to `prototype-workspace.json` in Electron's user-data folder. Empty projects can be removed from the sidebar; delete their nodes first when necessary.

After restarting ADE, saved nodes appear dormant. **Resume conversation** continues the matching Claude or Codex chat using the provider's locally saved session. Plain terminal nodes show up to 512 KiB of the previous shell incarnation's retained output for up to seven days, then **Reopen shell** starts a fresh process in the same project folder. Retained output preserves terminal control data but is display-only: it never makes the old process live or authorizes input. ADE labels bounded/incomplete history, ignores corrupt snapshots, replaces history when a new incarnation starts, and deletes it when the terminal node is removed (including when it moves into Recently Closed). Until a process owner reconnects, a terminal whose exit was not previously confirmed is marked **Unverifiable**, not **Exited**.

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
