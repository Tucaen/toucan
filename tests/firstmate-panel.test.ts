import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

test('renders the WSL crew backend as informational rather than a warning', () => {
  const panel = readFileSync(join(process.cwd(), 'src/renderer/src/FirstMatePanel.tsx'), 'utf8')
  const styles = readFileSync(join(process.cwd(), 'src/renderer/src/styles.css'), 'utf8')

  assert.match(
    panel,
    /className="firstmate-worker-info"[^>]*>[\s\S]*?Crew backend: tmux/,
    'the crew backend row should use an informational class'
  )
  assert.doesNotMatch(
    panel,
    /className="firstmate-worker-warning"[^>]*>[\s\S]*?Crew backend: tmux/,
    'the crew backend row must not be presented as a warning'
  )

  const infoRule = styles.match(/\.firstmate-worker-info\s*\{([^}]*)\}/)?.[1]
  assert.ok(infoRule, 'the crew backend informational style should exist')
  assert.doesNotMatch(infoRule, /#c9ad68|#211d14|#4f4529/i, 'the informational style must not use the warning palette')
})

test('offers one actionable Codex sign-in state when FirstMate authentication is required', () => {
  const panel = readFileSync(join(process.cwd(), 'src/renderer/src/FirstMatePanel.tsx'), 'utf8')
  const chat = readFileSync(join(process.cwd(), 'src/renderer/src/ChatNode.tsx'), 'utf8')

  assert.match(
    chat,
    /props\.status === ['"]auth_required['"]\s*\?\s*<AuthPanel[\s\S]*?\:\s*props\.messages\.length === 0/,
    'auth-required should replace the full-height empty state so its sign-in button is immediately visible'
  )

  const statusLabelUses = panel.match(/statusLabel\(conversation\.status\)/g) ?? []
  assert.equal(statusLabelUses.length, 1, 'FirstMate should show the auth status in only one place')
  assert.match(
    panel,
    /conversation\.detail\s*&&\s*conversation\.status\s*!==\s*['"]auth_required['"]/,
    'the ACP detail should not repeat the auth-required notice'
  )
  assert.match(
    panel,
    /runtime\.githubAuth === ['"]required['"]\s*&&\s*conversation\.status !== ['"]auth_required['"]/,
    'GitHub authentication should wait until the primary Codex authentication is complete'
  )
})

test('keeps model selection available while ChatGPT authentication is required', () => {
  const conversation = readFileSync(join(process.cwd(), 'src/renderer/src/use-agent-conversation.ts'), 'utf8')
  const manager = readFileSync(join(process.cwd(), 'src/main/acp-session-manager.ts'), 'utf8')

  assert.doesNotMatch(
    conversation,
    /selectorsDisabled:\s*[^\n]*status === ['"]auth_required['"]/,
    'authentication should block prompts, not model selection'
  )
  assert.match(
    manager,
    /status:\s*['"]auth_required['"][\s\S]*?\.\.\.\(models \? \{ models \} : \{\}\)/,
    'the auth-required response should still include cached model choices'
  )
  assert.match(
    manager,
    /if \(!running\.sessionId\)[\s\S]*?running\.request\.modelId = modelId[\s\S]*?return \{ ok: true \}/,
    'a pre-auth model choice should be saved and applied when the session opens'
  )
})

test('recovers FirstMate by starting fresh when its saved conversation cannot be resumed', () => {
  const manager = readFileSync(join(process.cwd(), 'src/main/acp-session-manager.ts'), 'utf8')

  assert.match(
    manager,
    /methods\.agent\.session\.load[\s\S]*?running\.request\.scope !== ['"]firstmate['"][\s\S]*?running\.request\.sessionId = undefined[\s\S]*?methods\.agent\.session\.new/,
    'a missing or incompatible FirstMate rollout should fall back to a new session'
  )
})

test('lets the user switch FirstMate between Codex and Claude even when one provider failed', () => {
  const panel = readFileSync(join(process.cwd(), 'src/renderer/src/FirstMatePanel.tsx'), 'utf8')
  const firstMate = readFileSync(join(process.cwd(), 'src/shared/firstmate.ts'), 'utf8')
  const manager = readFileSync(join(process.cwd(), 'src/main/acp-session-manager.ts'), 'utf8')

  assert.match(firstMate, /provider\?:\s*AgentProvider/)
  assert.match(panel, /kind="provider"[\s\S]*?disabled=\{false\}/)
  assert.match(panel, /\{ id: ['"]codex['"], name: ['"]Codex['"] \}/)
  assert.match(panel, /\{ id: ['"]claude['"], name: ['"]Claude['"] \}/)
  assert.match(manager, /resolveFirstMateLaunch\?\.\(request\.provider\)/)
})

test('requires explicit approval for FirstMate Codex hooks without blocking Claude', () => {
  const panel = readFileSync(join(process.cwd(), 'src/renderer/src/FirstMatePanel.tsx'), 'utf8')
  const firstMate = readFileSync(join(process.cwd(), 'src/shared/firstmate.ts'), 'utf8')
  const preload = readFileSync(join(process.cwd(), 'src/preload/index.ts'), 'utf8')

  assert.match(firstMate, /codexProjectTrust\?:\s*['"]trusted['"]\s*\|\s*['"]required['"]/)
  assert.match(panel, /provider === ['"]codex['"]\s*&&\s*runtime\.codexProjectTrust === ['"]required['"]/)
  assert.match(panel, /Enable Codex hooks/)
  assert.match(panel, /window\.firstMateApi\.trustCodexProject\(\)/)
  assert.match(panel, /setCodexHookError\(result\.message/)
  assert.match(
    panel,
    /enabled:\s*runtime\?\.state === ['"]ready['"]\s*&&\s*\(provider !== ['"]codex['"]\s*\|\|\s*runtime\.codexProjectTrust === ['"]trusted['"]\)/,
    'unapproved Codex hooks should prevent a doomed Codex launch while Claude remains enabled'
  )
  assert.match(preload, /trustCodexProject:\s*\(\).*firstmate:trust-codex/)
})
