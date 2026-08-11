# ADE canvas terminal prototype

> **PROTOTYPE — throwaway code.** This branch exists to answer one question: does creating live terminal and coding-agent nodes directly on a spatial canvas feel like the right core interaction for ADE?

Windows-only for this prototype. Sessions are deliberately in-memory and end when their nodes or the app close.

## Run

```powershell
npm install
npm run dev
```

The current folder starts as the first project. Use **Add project** in the left sidebar to choose more folders, then click a project to make it the creation target. All projects remain visible on one canvas. Right-click the canvas and choose **Terminal**, **Claude Code**, or **Codex**; the session starts in the selected project's folder and carries a project badge.

The number beside a project is its live node count. Click it to bring that project's nodes into view. Each project also lists its assigned sessions. Clicking a session focuses its node on the canvas. An unfocused session that finishes a burst of output is marked **Attention** until you focus or interact with it; ended processes are marked **Exited**.

Select terminal text with the mouse and use **Ctrl+Shift+C** (or the node's **Copy** button) to copy it. Use **Ctrl+Shift+V** to paste. The traditional **Ctrl+Insert** and **Shift+Insert** shortcuts work too.

## Deliberately excluded

- Persistence and session restore
- Mobile and remote access
- Authentication
- Agent orchestration and worktrees
- Project persistence, reordering, and removal
- Canvas edges, groups, and editors

The renderer talks to PTYs only through a narrow preload API. That is the sole forward-looking seam retained so a later implementation can replace local IPC with a remote transport without rewriting the canvas.
