# Toucan

Toucan is a Windows-first desktop workspace for arranging local shells, Claude sessions,
Codex sessions, and Git worktrees on one spatial canvas. It is under active development;
workspace state is stored locally and the Windows x64 builds are not yet signed.

## What Toucan does

- Keeps multiple projects, terminals, and coding-agent conversations visible on one
  zoomable canvas. Every node can temporarily fit the visible canvas and then restore its
  exact previous position and size from the header.
- Creates every canvas node type from the context menu or from the keyboard: `Ctrl+T` terminal,
  `Ctrl+N` Claude, `Ctrl+Shift+N` Codex, `Ctrl+Shift+G` worktree, `Ctrl+H` history browser and
  `Ctrl+P` file. A shortcut drops its node at the viewport centre and yields inside a terminal.
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

- Serves a mobile companion to your phone over your own tailnet. The remote server is off
  until you turn it on, pairing is one long token, and the phone shows the workspace's active
  agent chats with status, unread badges and a distinct "needs approval" state. Open one to
  read its transcript live, send a message, and answer what the agent is waiting on - tool
  permissions and structured questions alike. Answering is race-safe: whether you answer on
  the phone or on the desktop, exactly one answer reaches the agent and the other client's
  card resolves. Start a new chat for a project from the phone, and keep several PCs in one
  installed app, switching between them. Put `tailscale serve` in front of a host and the client
  installs to the Android home screen as a standalone app.

Live shell processes still end when Toucan exits, and live PTY process restoration is not
implemented.

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

Toucan opens the repository directory as its first project. Use **Add project** for more
folders, select a project in the sidebar, then right-click the canvas to create a
**Terminal**, **Claude**, **Codex**, or **Worktree** node, or to open **History**. Claude
and Codex use their existing subscription sign-in flows when authentication is required.

## Use Toucan from your phone

Remote access is off in a fresh install. Open it from the phone icon in the header, enable it,
and note the port and pairing token.

Reachability is deliberately not Toucan's problem: install [Tailscale](https://tailscale.com)
on the PC and the phone, join both to the same tailnet, then open `http://<tailnet-address>:<port>`
in the phone's browser and paste the pairing token once. The dialog lists the addresses to try
and labels the tailnet one. A device on your tailnet is _reachable_, not _trusted_ - the token is
what authorizes it, so **Regenerate** locks out every phone holding the old one.

To install the client to the home screen, put HTTPS in front of that port with
`tailscale serve` - a browser will not register a service worker over plain HTTP, so installing
needs a secure origin, and Toucan deliberately owns no certificates. Over plain HTTP the app
still works as an ordinary web page; it just never offers to install.

**[docs/mobile-companion-setup.md](docs/mobile-companion-setup.md)** walks the whole path
end to end, including adding a second PC and what the tailnet and the token each protect.

The desktop has to be running: the server lives in Toucan's main process, and the phone shows the
canvas that desktop has open. Plain terminals are never listed.

The phone client is built as static assets Toucan serves itself:

```powershell
npm run build:mobile
```

`npm run build` and `npm run package:win` already include it; run it once by hand before using
remote access from `npm run dev`.

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
npm run build:mobile
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

This produces two x64 artifacts in `dist/`:

- `Toucan-Setup-0.1.0-x64.exe` - an NSIS installer. It installs per user (no admin rights),
  lets you choose the directory, adds Start menu and desktop shortcuts, and is removed again
  through Settings > Apps. Prefer this one; in-place updates will build on it.
- `Toucan-0.1.0-portable-x64.exe` - a single executable that needs no installer and cannot
  update itself.

`npm run package:win:installer` and `npm run package:win:portable` build just one of them.

The builds are not digitally signed. When a downloaded exe is first run, Windows SmartScreen
shows "Windows protected your PC": click **More info**, then **Run anyway**.

## Architecture and project documentation

Toucan is an Electron application with a privileged main process, a narrow context-isolated
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
