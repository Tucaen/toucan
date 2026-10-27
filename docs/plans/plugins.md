---
title: Plugins plan
created: 2026-10-27
updated: 2026-10-27
status: planned
---

# Plugins: optional agent capabilities, enabled per project

Some agent capabilities are valuable for one kind of project and pure overhead for another: a
headless Godot runtime check for a game, a browser for a web app. Plugins let such a capability
ship outside Toucan's own code and be switched on only where it helps. This doc records the
decisions from the 2026-10-27 discussion and the first implementation slices.

The motivating evidence came from the session records (186 Claude transcripts): of 340 messages
the human typed, 35 reported a result as not good enough, 29 of them in the Godot project, almost
all found by playing the game (enemies stuck, UI clipped, icons missing, the game not starting).
The agents could not run the game and look. That fix is Godot-specific, so it belongs in a
plugin rather than in Toucan.

## Resolved decisions

1. **Agent-side plugins only.** A plugin contributes what an agent session consumes: skills,
   scripts the skills call, optional MCP servers, and (Claude only, for now) hooks. No UI plugins:
   no canvas node types, panels or settings contributed by plugin code. Revisit only when a
   concrete plugin needs UI (a visible browser node would).
2. **CLI is the default; MCP is supported.** Plugins we write expose tools as a skill plus a
   script the agent runs from its shell, the same reasoning as the orchestrator CLI
   (`orchestrator-mode.md`): no tool-definition tokens in sessions that never use it, and it works
   for every provider with a shell. A plugin may still declare MCP servers, for reusing an existing
   server unchanged (e.g. Playwright MCP) or for a tool that must hold live state between calls.
3. **Claude's plugin layout is the manifest.** A plugin is a folder with
   `.claude-plugin/plugin.json` (`name`, `version`, `description`), `skills/<name>/SKILL.md`, an
   optional `.mcp.json` and optional `hooks/`. Toucan's own `.agents` folder already uses this
   layout, Claude sessions can load such a folder natively as a local plugin, and Claude Code's
   marketplace format can later be adopted instead of invented. Toucan adds only what Claude's
   format lacks: the Codex translation and the Toucan context (below).
4. **Identity is `name` + `version`, never a path.** `name` is the plugin id and must be unique;
   `version` is semver and required. A per-user registry maps an id to where it lives on this
   machine. Today that is a local folder used in place, so edits apply to the next session.
5. **Enabled manually, per project, stored in Toucan's user settings.** Not in the repo. A
   worktree inherits its project's plugins. Changes apply to sessions created afterwards, as with
   the terminal-context edge.
6. **Enabling shows what a plugin contributes**: its skills, scripts, MCP server commands and
   hooks. A plugin runs code with the user's rights, like a VS Code extension; this screen is the
   trust step, and it already exists when plugins one day come from other people.
7. **Built-ins stay as they are.** The shipped skills (`orchestrate`, `session-records`,
   `session-messaging`, `route-claude-ticket`, `implement-in-worktree`), the command guard, the
   terminal-context MCP server and the session instructions are not moved onto the plugin
   mechanism. `brain-dump` was removed instead (#57): the orchestrator node made it
   superfluous.

## Design

- **Registry** (`<userData>/plugins.json`): `plugins: { [id]: { path } }` and
  `projects: { [projectPath]: id[] }`. Adding a plugin validates its manifest; an id already
  registered from another path is refused.
- **Delivery to a Claude session**: each enabled plugin's folder is appended to
  `_meta.claudeCode.options.plugins` as `{ type: 'local', path }`, beside the existing skills
  plugins (`sessionSkillsConfiguration` in `acp-session-manager.ts`). Claude then loads its skills,
  MCP servers and hooks itself.
- **Delivery to a Codex session**: skills through the same root mechanism Toucan uses for its own
  skills (`additionalDirectories`); the first slice must verify which folder layout Codex discovers
  there and adapt (copy or link into a Toucan-owned root if needed). MCP servers through config
  overrides (`mcp_servers.<name>.*`). Hooks are not delivered to Codex in the first version; the
  contributions screen says so.
- **Toucan context for scripts**: every session's adapter already carries `TOUCAN_NODE_ID`.
  Add `TOUCAN_PROJECT_DIR` (the main checkout; the session's cwd is the worktree). Each session
  that has plugins gets one appended instruction line per plugin naming its id and absolute root
  path, so a skill can reference `<root>/scripts/...` the same way for both providers.
- **Missing plugin**: an enabled id whose folder is gone or whose manifest no longer validates is
  skipped for that session and shown as a notice, never a failed session launch.

## Keeping a marketplace possible (not built now)

- Install would copy a plugin into `<userData>/plugins/<id>/<version>`; the registry entry then
  points there instead of at a working folder.
- A committed `.agents/plugins.json` could later _recommend_ ids for a project, as
  `.vscode/extensions.json` does; enabling stays the user's choice.
- Claude Code marketplaces (a git repo with `marketplace.json`) are the format to adopt.

## Slices

1. Registry, per-project enablement and session delivery for both providers (main process). #55
2. Plugins dialog: add a folder, enable per project, contributions view. Blocked by 1. #56
3. Godot runtime-check plugin: a CLI that runs a scene headless and writes screenshots and errors
   for the agent to read. Blocked by 1. Lives outside this repo. #58
4. Remove the brain-dump feature. Independent. #57
