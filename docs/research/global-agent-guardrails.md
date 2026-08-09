# Global agent guardrails: implications for ADE

Research date: 2026-08-09. This review uses only the skill and directly relevant implementation files in the source repository.

## Executive summary

`global-agent-guardrails` is a machine-global **regex denylist for shell command strings**. A shared Bash hook parses a supported agent's pre-execution JSON payload, compares the command against one POSIX-ERE pattern per line, and returns the host-specific block signal. The author accurately calls it a “seatbelt,” not a sandbox: it can stop common accidental catastrophes, but obfuscation or an uncovered execution path bypasses it. [Skill overview](https://github.com/davidondrej/skills/blob/main/skills/ops-and-setup/global-agent-guardrails/SKILL.md), [shared hook](https://github.com/davidondrej/skills/blob/main/hooks/deny-dangerous.sh)

ADE should reuse the ideas of a single policy source, pre-execution interception, explicit block/allow regression tests, and cross-agent adapters. It should **not** make a raw-command regex hook its security boundary. ADE should own a normalized guardrail service at the tool/execution broker, with typed policy decisions (`allow`, `require approval`, `deny`), workspace/path constraints, platform-specific command parsing, audit evidence, and a health/coverage signal. Vendor hooks should remain a secondary layer for sessions that can execute outside ADE's broker.

## Policy model

- The policy is intentionally narrow: block only irreversible or catastrophic operations, because broad blocking damages agent usefulness. The examples cover whole-root/home deletion, raw-disk writes and formatting, `sudo rm`, fork bombs, `curl|sh`, destructive remote Git operations, permission destruction at `/`, reflog destruction, destructive GitHub CLI calls, publicizing a repository, and printing the GitHub auth token. Recoverable local cleanup and `--force-with-lease` remain allowed. [Skill — design rule](https://github.com/davidondrej/skills/blob/main/skills/ops-and-setup/global-agent-guardrails/SKILL.md#add-or-tune-a-pattern), [pattern source](https://github.com/davidondrej/skills/blob/main/hooks/dangerous-patterns.txt)
- One text file is the intended source of truth. Blank lines and comments are ignored; every other line is a POSIX ERE. Consumers reread it for every command, so policy changes are immediate. Some JavaScript/Python adapters are instructed to translate POSIX character classes for their regex engines; Droid is an explicit exception whose native blocklist must be manually mirrored. [Skill — file map and tuning](https://github.com/davidondrej/skills/blob/main/skills/ops-and-setup/global-agent-guardrails/SKILL.md#file-map)
- The policy has only two outcomes at this layer: allow or hard block. There is no native “ask for approval,” risk score, scope, actor identity, project mode, temporary exception, or contextual condition. Droid's separate denylist-versus-blocklist distinction is documented, but not represented in the shared format. [Skill — per-agent wiring and gotchas](https://github.com/davidondrej/skills/blob/main/skills/ops-and-setup/global-agent-guardrails/SKILL.md#per-agent-wiring-user-global)

## Enforcement mechanism

```text
agent shell request
    -> host PreToolUse/pre-exec event
    -> adapter extracts raw command string
    -> shared regex policy
    -> allow | host-specific hard block
```

For Claude, Codex, and Devin, the proposed hook consumes `.tool_input.command`; Grok uses `.toolInput.command`; Cursor uses `.command`. The Bash script uses `jq`, scans every pattern with `grep -E`, and blocks a match with exit code 2 for the Claude/Codex-style contract or a deny JSON object for Cursor. [Shared hook implementation](https://github.com/davidondrej/skills/blob/main/hooks/deny-dangerous.sh)

The repository includes a useful table of native adapters: OpenCode throws from `tool.execute.before`, Pi returns `{block:true}` from `tool_call`, Hermes returns a block action from `pre_tool_call`, and Droid uses its built-in `commandBlocklist`. However, those native adapter implementations are not present in this repository's `hooks/` directory; the repository directly supplies only the patterns, the shared Bash hook, and its Bash tests. Their behavior is therefore installation guidance in this source set, not independently inspectable implementation evidence. [Skill — per-agent wiring](https://github.com/davidondrej/skills/blob/main/skills/ops-and-setup/global-agent-guardrails/SKILL.md#per-agent-wiring-user-global), [repository hooks directory](https://github.com/davidondrej/skills/tree/main/hooks)

The test suite sends dangerous and allowed command strings through both the Claude/Codex payload shape and Cursor payload shape. It checks exit code or JSON output and has positive and negative cases for every major pattern family. It does **not** test actual agent installation, hook discovery, trust state, execution under a real agent host, unsupported payloads, or adversarial encodings. [Guard test suite](https://github.com/davidondrej/skills/blob/main/hooks/test-guard.sh)

## Codex and Claude portability

The design claims a shared Claude Code and Codex CLI/app/IDE wiring shape: a user-global `PreToolUse` entry matching `Bash`, invoking the same absolute hook path, with exit 2 as the block signal. This makes policy behavior portable **if** both hosts emit the documented payload and invoke the trusted hook. The shared tests deliberately exercise that common JSON shape. [Skill — wiring table](https://github.com/davidondrej/skills/blob/main/skills/ops-and-setup/global-agent-guardrails/SKILL.md#per-agent-wiring-user-global), [tests — Claude/Codex shape](https://github.com/davidondrej/skills/blob/main/hooks/test-guard.sh)

Important limitations:

- Codex hook trust is described as hash-pinned. Editing the hook entry requires interactive re-trust; otherwise the skill warns that Codex may silently skip it. Cloud Codex tasks are explicitly uncovered. [Skill — Codex gotcha](https://github.com/davidondrej/skills/blob/main/skills/ops-and-setup/global-agent-guardrails/SKILL.md#gotchas-hard-won--do-not-rediscover)
- Claude/Codex portability here covers a tool named or matched as `Bash`, not every process-spawning capability. A Windows ADE using PowerShell, native process APIs, MCP tools, desktop host tools, containers, or agent-written helper programs needs additional interception. The supplied hook itself is Bash and assumes Unix paths, `$HOME`, `jq`, `grep -E`, and POSIX command syntax. [Shared hook](https://github.com/davidondrej/skills/blob/main/hooks/deny-dangerous.sh), [patterns](https://github.com/davidondrej/skills/blob/main/hooks/dangerous-patterns.txt)
- An E2E recipe invokes real Claude, Codex, Droid, Pi, and Hermes sessions against `git push --force` in a non-repository directory. That is a good safe smoke-test design, but the repository does not contain captured results proving those probes passed on a particular version. [Skill — E2E verification](https://github.com/davidondrej/skills/blob/main/skills/ops-and-setup/global-agent-guardrails/SKILL.md#e2e-verification-recipe)

## What is actually enforced vs. merely instructed

| Property | Status | Reason |
|---|---|---|
| Matching visible raw shell strings | Technically blocked, conditionally | The host must invoke the hook; the payload, dependencies, and patterns must be readable; then a regex match returns the host's hard-block signal. |
| Policy update without restart | Technically implemented | The script opens the patterns file on every request. |
| Catastrophic command coverage | Partial heuristic | Listed spellings are blocked; equivalent programs, aliases, variables, encodings, scripts, interpreters, or indirect APIs can bypass string regexes. |
| No bypass by the agent | Not enforced | The skill itself says it is not a sandbox and gives Python obfuscation as an escape example. |
| “Do not retry or work around” | Instruction only | This text is returned to the model after a block; another execution path can ignore it. |
| Global coverage across sessions | Configuration claim | Every agent and execution host must be wired correctly. The skill lists explicit unsupported and background/cloud gaps. |
| Hook availability/integrity | Fail-open | Missing `jq`, missing patterns, an empty/unrecognized command field, and regex errors allow execution. [Shared hook](https://github.com/davidondrej/skills/blob/main/hooks/deny-dangerous.sh) |
| Correct installation/trust | Operational procedure | State checks and E2E probes can detect problems, but the policy file does not force installation or Codex trust. |

## Integration risks for ADE

1. **False confidence:** “global” may be read as sandbox-grade coverage even though the source explicitly excludes malicious bypass resistance and several execution environments.
2. **Fail-open dependencies:** a broken/missing `jq`, pattern file, payload field, or adapter silently permits the command. That is reasonable for a personal convenience hook but wrong for ADE's central safety boundary.
3. **Raw-string ambiguity:** harmless argument text containing a blocked phrase can false-positive, while semantic equivalents and generated scripts can false-negative. The skill documents the harmless-argument case itself. [Skill — false-positive gotcha](https://github.com/davidondrej/skills/blob/main/skills/ops-and-setup/global-agent-guardrails/SKILL.md#gotchas-hard-won--do-not-rediscover)
4. **Regex dialect drift:** POSIX ERE is translated into other engines by convention. A rule can compile or behave differently across Bash, JavaScript, and Python; Droid is manually duplicated and can drift immediately.
5. **Platform mismatch:** the checked-in policy is macOS/Linux-oriented. It does not cover Windows/PowerShell destruction such as broad `Remove-Item`, disk-management cmdlets, `cmd.exe` forms, registry damage, or Windows path resolution.
6. **Hook/version drift:** event names, payload shapes, trust models, and block semantics are vendor contracts. The unit tests prove the local script, not end-to-end interception in every installed agent version.
7. **Over-broad machine-global policy:** a single personal denylist ignores the distinction between read-only scouts, worktree workers, administrators, remote hosts, projects, and explicitly approved operations.
8. **Bypass outside shell:** file, GitHub, cloud, database, browser, and custom MCP tools can perform destructive operations without emitting a shell command. Guardrails must apply to capabilities, not just command text.

## Recommended ADE-owned guardrail abstraction

ADE should make guardrails a service at the execution boundary:

```text
AgentToolIntent
  actor/session + capability + structured args + cwd/target + environment
        -> normalize and resolve paths/resources
        -> policy engine
        -> ALLOW | REQUIRE_APPROVAL | DENY
        -> executor/sandbox
        -> immutable decision + execution audit record
```

Recommended properties:

- **One versioned policy model, many adapters.** Store typed rules in ADE, compile only the minimal compatibility projection to Claude/Codex hooks, and report which sessions are covered. Do not duplicate policy manually.
- **Capability-aware decisions.** Model filesystem deletion, Git history rewrite, remote deletion, credential access, process control, network-to-executable flow, and privilege escalation as capabilities. Inspect structured tool arguments before falling back to raw command parsing.
- **Three outcomes.** Reserve immutable deny rules for catastrophic operations; use approval for legitimate but risky actions; allow safe/recoverable operations. Approval should be scoped to the exact normalized action, target, session, and expiry—not a blanket bypass flag.
- **Resolved boundaries.** Canonicalize paths, validate workspace roots, reject symlink/junction escapes, and distinguish disposable worktrees from the vault, home, device roots, and remote resources.
- **Platform parsers.** Support PowerShell and Windows process invocation as first-class grammars alongside POSIX shells. Treat nested shells, scripts, and interpreter entrypoints conservatively.
- **Fail closed for ADE-owned execution.** If policy cannot load or an intent cannot be normalized, stop and surface a repair/approval event. Provide a narrowly scoped, explicit, audited break-glass path for the owner.
- **Defense in depth.** Run bounded sessions under least-privilege OS accounts, filesystem/network sandboxes, and credential brokers. Install vendor hooks to catch direct agent execution, but never count them as the sole boundary.
- **Continuous proof.** Maintain block, allow, bypass, and false-positive corpora per platform and adapter; run real-host safe probes after installation or upgrades; expose policy version, hook trust, last probe, and uncovered execution paths in ADE's session UI.
- **Mobile-safe approvals.** A phone may answer a pending decision, but the UI must show the exact normalized action, target, consequence, and expiry; it should never approve an opaque raw transcript or grant durable unrestricted shell authority.

## Bottom line

Adopt the repository's small, testable “pre-execution bouncer” as a compatibility layer. ADE's actual guardrail must sit below the agents, above every executor, and reason about normalized capabilities and targets. Instructions influence cooperative agents; only interception, least privilege, and sandboxing constrain execution.

