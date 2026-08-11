# ADE canvas terminal prototype

> **PROTOTYPE — throwaway code.** This branch exists to answer one question: does creating live terminal and coding-agent nodes directly on a spatial canvas feel like the right core interaction for ADE?

Windows-only for this prototype. Sessions are deliberately in-memory and end when their nodes or the app close.

## Run

```powershell
npm install
npm run dev
```

Right-click the canvas and choose **Terminal**, **Claude Code**, or **Codex**. Agent entries launch the corresponding local `claude` or `codex` CLI and show an in-node message when the command is unavailable.

Select terminal text with the mouse and use **Ctrl+Shift+C** (or the node's **Copy** button) to copy it. Use **Ctrl+Shift+V** to paste. The traditional **Ctrl+Insert** and **Shift+Insert** shortcuts work too.

## Deliberately excluded

- Persistence and session restore
- Mobile and remote access
- Authentication
- Agent orchestration and worktrees
- Canvas edges, groups, editors, and project management

The renderer talks to PTYs only through a narrow preload API. That is the sole forward-looking seam retained so a later implementation can replace local IPC with a remote transport without rewriting the canvas.
