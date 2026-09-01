# ADE

ADE is a Windows-first desktop workspace for arranging local shells, Claude sessions,
Codex sessions, and Git worktrees on one spatial canvas. It is under active development;
workspace state is stored locally and the Windows x64 portable build is not yet signed.

## What ADE does

- Keeps multiple projects, terminals, and coding-agent conversations visible on one
  zoomable canvas.
- Runs Claude and Codex through provider-neutral ACP chat nodes with sign-in, approvals,
  model and effort controls, slash commands, Markdown, file attachments, and local voice
  dictation.
- Interleaves plans, reasoning, commands, edits, delegation, and other tool activity with
  the conversation transcript. **Focus** mode hides that detail without discarding it.
- Queues prompts submitted while an agent is busy, with controls to edit, withdraw, or
  explicitly send a queued prompt into the running turn.
- Creates and discovers Git worktrees as persistent canvas nodes. Sessions opened from a
  worktree share its working directory, and removal is blocked or confirmed according to
  the work that would be lost.
- Browses locally recorded Claude and Codex conversation history across a project checkout
  and its worktrees, then resumes a selected conversation as a new canvas node.
- Restores saved canvas state, conversation nodes, drafts, attention, and recently closed
  sessions. `Ctrl+Shift+T` reopens the most recently closed session node.
- Shows retained display-only output for dormant plain terminals and provider account or
  session usage when the provider exposes it.
- Browses the personal brain-dump library in a resizable panel docked beside the canvas:
  search active or archived topics, follow `[[slug]]` links, and archive completed topics.
  Archived topics remain immutable snapshots; later work is captured as a linked active
  follow-up. Capture a new dump by typing or dictating it for the brain-dump skill to organize
  in the background. `Ctrl+Shift+B` toggles the panel; `Ctrl+K` focuses its search while it is open.

Live shell processes still end when ADE exits. Mobile access, remote access, and live PTY
process restoration are not implemented.

## Set up and run

Development currently targets Windows with a current Node.js LTS release, npm, and Git.
From PowerShell in the repository checkout:

```powershell
npm ci
npm run dev
```

The first launch prepares the bundled experimental English speech-to-text model. This may
download about 165 MB into the gitignored
`src/renderer/public/models/moonshine-small-streaming-en/` directory.

ADE opens the repository directory as its first project. Use **Add project** for more
folders, select a project in the sidebar, then right-click the canvas to create a
**Terminal**, **Claude**, **Codex**, or **Worktree** node, or to open **History**. Claude
and Codex use their existing subscription sign-in flows when authentication is required.

## Verify changes

Run the required pre-handoff gate:

```powershell
npm run check
```

It checks formatting, typed ESLint, architecture dependency rules, strict TypeScript, and
both test suites. Tests use temporary local data and do not invoke Claude or Codex.

Focused commands are available during development:

```powershell
npm run format:check
npm run lint
npm run check:architecture
npm run typecheck
npm test
npm run test:dom
```

For packaging or voice-model changes, run the extended gate, which also verifies the local
model assets and creates a production build:

```powershell
npm run check:full
```

## Package for Windows

```powershell
npm run package:win
```

The output is the portable x64 executable `dist/ADE-0.1.0-portable-x64.exe`. It needs no
installer. The build currently uses Electron's default icon and is not digitally signed,
so Windows may show an unfamiliar-app warning.

## Architecture and project documentation

ADE is an Electron application with a privileged main process, a narrow context-isolated
preload seam, and a React renderer. Shared modules hold cross-process contracts and pure
domain rules. See the [architecture map](docs/architecture.md) for process topology,
module ownership, dependency direction, important seams, and representative verification
paths.

Documentation has deliberately separate roles:

- This README is the human entry point for current product behavior, setup, and everyday
  commands.
- [docs/architecture.md](docs/architecture.md) maps the current code structure and its
  dependency boundaries.
- [AGENTS.md](AGENTS.md) records non-obvious operational invariants and sharp edges for
  agents working in the repository.
- `docs/brain-dumps`, `docs/research`, and `docs/prototypes` preserve ideas, investigations,
  and experiments; they are not claims about current behavior unless promoted into the
  README or architecture map.
