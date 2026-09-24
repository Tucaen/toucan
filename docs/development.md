# Developing Toucan

Setting up a checkout, the verification gate, packaging and releases. For what the app does,
see [features](features.md); for how the code is structured, see the
[architecture map](architecture.md).

## Set up and run

Development currently targets Windows with Node.js 24 or newer (`.nvmrc` and `engines.node`
agree on this), npm, and Git.
From PowerShell in the repository checkout:

```powershell
npm ci
npm run dev
```

Dictation downloads its speech engine and model (whisper.cpp with large-v3-turbo, about 1.6 GB)
into Toucan's user-data directory the first time the microphone is used; nothing is fetched at
build or launch time. See [voice input](voice-input.md) for what runs where and how
to measure accuracy on your own recordings.

Toucan opens the repository directory as its first project. Use **Add project** for more
folders, select a project in the sidebar, then right-click the canvas to create a
**Terminal**, **Claude**, **Codex**, or **Worktree** node, or to open **History**. Claude
and Codex use their existing subscription sign-in flows when authentication is required.

## Build the phone client

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
`.github/workflows/ci.yml` runs the same gate on every push to `main` and every pull request.

Focused commands are available during development:

```powershell
npm run format:check
npm run lint
npm run check:architecture
npm run typecheck
npm test
npm run build:mobile
```

For packaging changes, run the extended gate, which also creates a production build:

```powershell
npm run check:full
```

## Package for Windows

```powershell
npm run package:win
```

This produces two x64 artifacts in `dist/`:

- `Toucan-Setup-0.1.0-x64.exe` - an NSIS installer. It installs per user (no admin rights),
  lets you choose the directory, and is removed again through Settings > Apps. Prefer this one: it is the
  only build that updates itself.
- `Toucan-0.1.0-portable-x64.exe` - a single executable that needs no installer and cannot
  update itself.

`npm run package:win:installer` and `npm run package:win:portable` build just one of them.

The builds are not digitally signed. When a downloaded exe is first run, Windows SmartScreen
shows "Windows protected your PC": click **More info**, then **Run anyway**.

An installed Toucan checks the public releases feed on startup and downloads a newer version in
the background. Nothing is installed until you click **Restart to update** on the version chip in
the header, so an update never interrupts a running session. That chip also shows the version you
are on and checks for updates when clicked. Portable builds and `npm run dev` never contact the
feed.

## Release

Builds are published as [GitHub Releases](https://github.com/Tucaen/toucan/releases/latest) of
this repository (the `build.publish` block in `package.json` is the single source of truth for
that destination), so anyone can download the installer without a GitHub account. Releases up to
v0.17.12 were published on the former
[Tucaen/toucan-releases](https://github.com/Tucaen/toucan-releases/releases) repository; v0.17.12
is the bridge release there that moves installed builds onto this feed. Cutting a release:

```powershell
npm run release -- patch|minor|major
```

`scripts/release.mjs` bumps the version, shows the change list since the previous tag, and on
confirmation writes it into the tag annotation and pushes - the annotation is where the
published release notes come from, so a bare `npm version` tag would publish the
"Automated release." fallback instead. The tag runs `.github/workflows/release.yml` on a
Windows runner: it verifies the change with `npm run check`, builds, and only then packages and
uploads both artifacts plus the `latest.yml` and `.blockmap` files that in-place updates will
read. A failing check publishes nothing. Release notes are public - keep internal details out
of them.
