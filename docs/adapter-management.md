# Adapter management

Toucan keeps its pinned package.json/package-lock.json adapters as the immutable bundled
choice and lets users install a published version of either supported adapter independently.
The header's Agent adapters dialog lists registry versions, marks prereleases and installed
versions, and supports explicit selection and offline return to the bundle. Checking never
installs. There is no automatic update policy.

`src/main/adapter-manager.ts` owns the selection and the installation lifecycle. It exposes
snapshot, check, select, resolve and change subscription. `src/main/adapter-installer.ts`
owns npm execution and a bounded ACP initialize probe. The IPC contract is defined in
`src/shared/adapter-management.ts`; the renderer cannot pass an arbitrary package or path.

Each `<userData>/adapters/<provider>/<version>` contains its own package.json, dependency
tree, package-lock.json and successful-validation receipt. Installs are staged beside that
directory and renamed into place only after validation. Selection is persisted by a
separate atomic rename, with writes serialized across providers. A failed operation keeps
the previous selection. Existing installations are reused, preserving their exact resolved
dependencies; a version number alone would not reproduce a dependency declared as a range.
Installed versions are retained for offline rollback and never removed by an update.

Session creation resolves the selected entry once. Existing processes and their terminal
authentication launches retain their original entry. A Toucan upgrade changes the bundle
while a downloaded selection stays pinned. A missing or damaged selected installation at
startup restores the bundle with an explanation in the dialog. Interrupted staging folders
are never considered installed; they may be removed manually while Toucan is closed.

The initialize probe neither creates a conversation nor sends a prompt. It checks the ACP
protocol version and that the adapter starts under Toucan's runtime, but cannot guarantee
history replay, steering, questions, model access, or other adapter extensions. Unsupported
Node engine requirements fail installation. Versions requiring installation scripts are
unsupported: scripts are disabled. These limits preserve a usable fallback rather than
promising compatibility with every published version. Provider account usage readers remain
app-owned integrations with the versions shipped with Toucan; changing a chat adapter does
not replace the SDK executing inside Toucan's main process.

## Installer dependency

The new runtime dependency is npm, pinned to 11.19.1 (Artistic-2.0). Existing dependencies do
not install npm dependency trees or produce lockfiles, and relying on a user's npm would
make installed builds depend on an undeclared prerequisite. npm supplies dependency
resolution, registry integrity verification, platform optional dependencies and lockfiles.
Its package reports roughly 12 MB unpacked; it adds installer files and bundled JavaScript
dependencies, not another native runtime. It is unpacked beside app.asar and invoked by
Toucan's Electron executable in Node mode, using the existing hidden-process policy on
Windows. The packaged npm CLI is maintained deliberately alongside Toucan releases.

The installer fixes the public registry, isolates user/global npm configuration and cache
under userData, rejects ranges/tags/paths at IPC, disables lifecycle scripts, and enforces
engine requirements. Native provider binaries arrive through the installed packages'
platform-specific optional dependencies. Downloaded adapters execute with the same user
privileges as the bundled adapters.

## Validation

Node tests cover bundle resolution, selection persistence across application upgrades,
offline rollback, failed validation/retry, concurrent selection writes, and invalid IPC
inputs. Process tests exercise actual ACP initialize responses and timeout cleanup through
small adapter fixtures. DOM tests exercise checking, explicit installation, and fallback;
launch tests verify old and new sessions receive their respective adapter paths.

Packaged Windows testing must verify the unpacked npm CLI can check/install, both providers
start, a conversation still resumes from History, and returning to bundled works. The
handshake check is intentionally weaker than this live product smoke test.
