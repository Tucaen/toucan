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
  assert.match(manager, /resolveFirstMateLaunch\?\.\(request\.provider, request\.modelId\)/)
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

test('lets the user replace a read-only captain with a genuinely fresh FirstMate session', () => {
  const panel = readFileSync(join(process.cwd(), 'src/renderer/src/FirstMatePanel.tsx'), 'utf8')
  const conversation = readFileSync(join(process.cwd(), 'src/renderer/src/use-agent-conversation.ts'), 'utf8')

  assert.match(panel, />New session</)
  assert.match(panel, /conversationId: undefined/)
  assert.match(panel, /setSessionGeneration\(\(current\) => current \+ 1\)/)
  assert.match(panel, /sessionId:\s*sessionGeneration === 0 \? state\.conversationId : undefined/)
  assert.match(panel, /restartKey:\s*sessionGeneration/)
  assert.match(conversation, /restartKey\?:\s*number/)
  assert.match(
    conversation,
    /\[options\.cwd, options\.enabled, options\.id, options\.provider, options\.restartKey, options\.scope\]/,
    'changing the restart key must tear down the old ACP process and create a new session'
  )
})

test('requires explicit unrestricted fleet access before restarting an operational captain', () => {
  const panel = readFileSync(join(process.cwd(), 'src/renderer/src/FirstMatePanel.tsx'), 'utf8')
  const conversation = readFileSync(join(process.cwd(), 'src/renderer/src/use-agent-conversation.ts'), 'utf8')

  assert.match(panel, /provider === ['"]codex['"] \? ['"]agent-full-access['"] : ['"]bypassPermissions['"]/)
  assert.match(panel, /Enable fleet access/)
  assert.match(panel, /unrestricted command, filesystem, and network access/)
  assert.match(panel, /conversation\.selectMode\(requiredFleetMode\)/)
  assert.match(panel, /startNewSession\(requiredFleetMode\)/)
  assert.match(conversation, /selectMode\(modeId: string\): Promise<boolean>/)
  assert.match(conversation, /if \(modeId === modes\?\.currentModeId\) return true/)
  assert.match(conversation, /if \(result\.ok\)[\s\S]*?return true[\s\S]*?return false/)
})

test('reports a recoverable validation dispatch state in the delivery lifecycle', () => {
  const panel = readFileSync(join(process.cwd(), 'src/renderer/src/FirstMatePanel.tsx'), 'utf8')
  const styles = readFileSync(join(process.cwd(), 'src/renderer/src/styles.css'), 'utf8')

  assert.match(panel, /dispatching: 'Dispatching'/, 'a claimed dispatch needs its own visible stage')
  assert.match(
    panel,
    /task\.dispatch\?\.status === 'unresolved'\) return `\$\{stage\} . recover dispatch`/,
    'an unresolved dispatch must read as recoverable rather than as progress'
  )
  assert.match(
    panel,
    /task\.dispatch\?\.status === 'retryable'[\s\S]*?dispatch retry/,
    'a rejected dispatch waiting on a retry must be distinguishable from a plain implementation'
  )
  assert.match(
    panel,
    /data-dispatch=\{task\.dispatch\?\.status\}/,
    'the dispatch outcome should be addressable for styling'
  )
  assert.match(
    styles,
    /\.firstmate-lifecycle-task\[data-dispatch="unresolved"\] > strong/,
    'a dispatch ADE cannot resolve should not look like a healthy stage'
  )
})

test('assigns every FirstMate request to the project selected in the sidebar', () => {
  const app = readFileSync(join(process.cwd(), 'src/renderer/src/App.tsx'), 'utf8')
  const panel = readFileSync(join(process.cwd(), 'src/renderer/src/FirstMatePanel.tsx'), 'utf8')
  const conversation = readFileSync(join(process.cwd(), 'src/renderer/src/use-agent-conversation.ts'), 'utf8')

  assert.match(
    app,
    /<FirstMatePanel[\s\S]*?project=\{activeProject\}/,
    'the FirstMate dock should receive the current sidebar selection'
  )
  assert.match(
    panel,
    /composePrompt:\s*async \(text\) => \{[\s\S]*?registerProject\(firstMateProjectSelection\(project\)\)[\s\S]*?return firstMateRequest\(project, text, result\)/,
    'FirstMate should identify the selected project on every request without changing its distro cwd'
  )
  assert.match(
    conversation,
    /const prompt = compose \? await compose\(text\) : text[\s\S]*?window\.agentApi\.prompt\(options\.id, prompt\)/,
    'the project assignment should be sent to the agent while the visible chat keeps the captain\'s original text'
  )

  const sessionDependencies = conversation.match(/\}, \[options\.cwd[^\]]*\]\)/)?.[0]
  assert.ok(sessionDependencies, 'the ACP session should declare its dependencies')
  assert.doesNotMatch(
    sessionDependencies,
    /composePrompt/,
    'retargeting the next request must not restart the persistent captain conversation'
  )
})

test('shows the project the next FirstMate request will target', () => {
  const panel = readFileSync(join(process.cwd(), 'src/renderer/src/FirstMatePanel.tsx'), 'utf8')
  const styles = readFileSync(join(process.cwd(), 'src/renderer/src/styles.css'), 'utf8')

  const target = panel.match(/className="firstmate-request-target"[\s\S]*?<\/div>/)?.[0]
  assert.ok(target, 'the dock should name its request target before the captain submits')
  assert.match(target, /requestTarget\.name/, 'the target row should name the project')
  assert.match(target, /requestTarget\.windowsPath/, 'the target row should distinguish similarly named projects by path')
  assert.match(target, /title=\{`\$\{requestTarget\.windowsPath\}[\s\S]*?requestTarget\.wslPath\}`\}/)
  assert.match(styles, /\.firstmate-request-target\s*\{/, 'the target row needs its own style')
})

test('registers the selected project on the request and keeps mere selection read-only', () => {
  const panel = readFileSync(join(process.cwd(), 'src/renderer/src/FirstMatePanel.tsx'), 'utf8')
  const app = readFileSync(join(process.cwd(), 'src/renderer/src/App.tsx'), 'utf8')
  const preload = readFileSync(join(process.cwd(), 'src/preload/index.ts'), 'utf8')

  const selectionEffect = panel.match(/\/\/ Selecting a project only reads[\s\S]*?\}, \[project\.id, runtime\?\.state\]\)/)?.[0]
  assert.ok(selectionEffect, 'switching projects should read the recorded registration')
  assert.match(selectionEffect, /recordedProject\(project\.id\)/)
  assert.doesNotMatch(selectionEffect, /registerProject/, 'selecting a project must not register or mutate it')
  assert.match(preload, /registerProject:[\s\S]*?firstmate:register-project/)
  assert.match(preload, /recordedProject:[\s\S]*?firstmate:recorded-project/)
  assert.match(
    app,
    /retireProject\(projectId\)/,
    'removing a project from the sidebar should retire its registration'
  )
})

test('holds no-mistakes gate setup behind an explicit authorization in the dock', () => {
  const panel = readFileSync(join(process.cwd(), 'src/renderer/src/FirstMatePanel.tsx'), 'utf8')
  const preload = readFileSync(join(process.cwd(), 'src/preload/index.ts'), 'utf8')

  assert.match(panel, /registration\?\.initialization === ['"]required['"]/)
  assert.match(panel, /Authorize gate setup/)
  assert.match(panel, /authorizeProjectInitialization\(project\.id\)/)
  assert.match(panel, /registration\.windowsPath/, 'the authorization must name the checkout it would write to')
  assert.match(preload, /authorizeProjectInitialization:[\s\S]*?firstmate:authorize-project-init/)
})

test('shows the registered delivery posture of the project the next request targets', () => {
  const panel = readFileSync(join(process.cwd(), 'src/renderer/src/FirstMatePanel.tsx'), 'utf8')
  const styles = readFileSync(join(process.cwd(), 'src/renderer/src/styles.css'), 'utf8')

  const target = panel.match(/className="firstmate-request-target"[\s\S]*?\n          <\/div>/)?.[0]
  assert.ok(target, 'the dock should still name its request target')
  assert.match(target, /registration\.mode/)
  assert.match(target, /registration\.autonomy \? ' \+yolo' : ''/)
  assert.match(target, /registration\.registryName/)
  assert.match(styles, /\.firstmate-project-posture\s*\{/)
})
