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

// The renderer half of this behavior (the auth overlay rendering as a dedicated aria-modal
// dialog while status is auth_required or reauthenticating) is exercised for real via
// role=dialog/aria-modal assertions in chat-auth-panel.dom.test.tsx.
test('offers one actionable Codex sign-in state when FirstMate authentication is required', () => {
  const panel = readFileSync(join(process.cwd(), 'src/renderer/src/FirstMatePanel.tsx'), 'utf8')

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

// The renderer half of this behavior (selectorsDisabled staying false through auth_required) is
// exercised for real via renderHook in firstmate-panel.dom.test.tsx. The main-process half below
// (acp-session-manager.ts caching a pre-auth model choice) is cross-process and stays source-text.
test('keeps a pre-auth model choice cached and applied by the session manager once the session opens', () => {
  const manager = readFileSync(join(process.cwd(), 'src/main/acp-session-manager.ts'), 'utf8')

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

test('resolves each captain launch through the provider-aware FirstMate launcher', () => {
  const panel = readFileSync(join(process.cwd(), 'src/renderer/src/FirstMatePanel.tsx'), 'utf8')
  const manager = readFileSync(join(process.cwd(), 'src/main/acp-session-manager.ts'), 'utf8')

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
  assert.match(panel, /setSessionGenerations\(\(current\) => \(\{/)
  assert.match(panel, /sessionId:\s*captain\.conversationId/)
  assert.match(panel, /restartKey:\s*sessionGenerations\[provider\] \?\? 0/)
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
    /task\.dispatch\?\.status === 'unresolved'[\s\S]*?' . dispatch unresolved'/,
    'an unresolved dispatch must read as unsettled rather than as progress'
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

test('offers an explicit way out of a validation dispatch ADE cannot resolve', () => {
  const panel = readFileSync(join(process.cwd(), 'src/renderer/src/FirstMatePanel.tsx'), 'utf8')
  const preload = readFileSync(join(process.cwd(), 'src/preload/index.ts'), 'utf8')
  const main = readFileSync(join(process.cwd(), 'src/main/index.ts'), 'utf8')

  assert.match(
    panel,
    /task\.dispatch\?\.status === 'unresolved' && \([\s\S]*?onClick=\{\(\) => releaseDispatch\(task\.id\)\}/,
    'an unresolved dispatch must be releasable from the row that reports it'
  )
  assert.match(
    panel,
    /window\.firstMateApi\.releaseDispatch\(taskId\)/,
    'the release should go through the FirstMate bridge rather than a local state change'
  )
  assert.match(preload, /releaseDispatch: \(taskId: string\)[\s\S]*?'firstmate:release-dispatch'/)
  assert.match(
    main,
    /'firstmate:release-dispatch'[\s\S]*?typeof taskId === 'string' && taskId \? lifecycle\.releaseDispatch\(taskId\)/,
    'releasing a dispatch is reconciliation work, so it belongs to the lifecycle coordinator'
  )
})

test('offers an explicit retry for a dispatch whose pre-send attempts were exhausted', () => {
  const panel = readFileSync(join(process.cwd(), 'src/renderer/src/FirstMatePanel.tsx'), 'utf8')
  const preload = readFileSync(join(process.cwd(), 'src/preload/index.ts'), 'utf8')
  const main = readFileSync(join(process.cwd(), 'src/main/index.ts'), 'utf8')

  assert.match(
    panel,
    /task\.stage === 'blocked' && task\.dispatch\?\.status === 'retryable' && \([\s\S]*?onClick=\{\(\) => retryDispatch\(task\.id\)\}/,
    'an attempts-exhausted dispatch must be retryable from the row that reports it'
  )
  assert.match(
    panel,
    /window\.firstMateApi\.retryDispatch\(taskId\)/,
    'the retry should go through the FirstMate bridge rather than a local state change'
  )
  assert.match(preload, /retryDispatch: \(taskId: string\)[\s\S]*?'firstmate:retry-dispatch'/)
  assert.match(
    main,
    /'firstmate:retry-dispatch'[\s\S]*?typeof taskId === 'string' && taskId \? lifecycle\.retryDispatch\(taskId\)/,
    'retrying a dispatch is reconciliation work, so it belongs to the lifecycle coordinator'
  )
})

// FirstMatePanel cannot be mounted in the jsdom/RTL harness for real (it pulls in the same
// @xyflow/react/@moonshine-ai/moonshine-wasm dependencies documented in firstmate-panel.dom.test.tsx),
// so this stays a source-text assertion like the release/retry tests above. The main-process command
// that actually spawns wt.exe/tmux is exercised for real in firstmate-runtime.test.ts; nothing here
// simulates that spawn.
test('lets the captain open a real terminal attached to any task\'s live worker session', () => {
  const panel = readFileSync(join(process.cwd(), 'src/renderer/src/FirstMatePanel.tsx'), 'utf8')
  const preload = readFileSync(join(process.cwd(), 'src/preload/index.ts'), 'utf8')
  const main = readFileSync(join(process.cwd(), 'src/main/index.ts'), 'utf8')
  const runtime = readFileSync(join(process.cwd(), 'src/main/firstmate-runtime.ts'), 'utf8')

  assert.match(
    panel,
    /className="firstmate-view-terminal"[\s\S]*?onClick=\{\(\) => viewWorkerTerminal\(task\.id\)\}/,
    'every task row must offer a way to view its live worker terminal, not only tasks in trouble'
  )
  assert.match(
    panel,
    /window\.firstMateApi\.viewWorkerTerminal\(taskId\)/,
    'opening the terminal should go through the FirstMate bridge rather than a local state change'
  )
  assert.match(preload, /viewWorkerTerminal: \(taskId: string\)[\s\S]*?'firstmate:view-worker-terminal'/)
  assert.match(
    main,
    /'firstmate:view-worker-terminal'[\s\S]*?typeof taskId === 'string' && taskId \? runtime\.openWorkerTerminal\(taskId\)/,
    'the IPC handler should validate the task id before asking the runtime to open a terminal'
  )
  assert.match(
    runtime,
    /openWorkerTerminal\(taskId: string\): Promise<FirstMateActionResult>/,
    'the FirstMate runtime contract must expose opening a worker terminal'
  )
  assert.match(
    runtime,
    /has-session['"],\s*'-t',\s*target/,
    'the runtime must confirm the recorded tmux window is still alive before attaching a terminal to it'
  )
  assert.match(
    runtime,
    /No recorded live worker window|no recorded live worker window/,
    'a task with no recorded window binding must report a clear reason rather than opening a broken terminal'
  )
})

test('gives every FirstMate request the full project catalog and the active sidebar hint', () => {
  const app = readFileSync(join(process.cwd(), 'src/renderer/src/App.tsx'), 'utf8')
  const panel = readFileSync(join(process.cwd(), 'src/renderer/src/FirstMatePanel.tsx'), 'utf8')
  const conversation = readFileSync(join(process.cwd(), 'src/renderer/src/use-agent-conversation.ts'), 'utf8')

  assert.match(
    app,
    /<FirstMatePanel[\s\S]*?projects=\{projects\}[\s\S]*?project=\{activeProject\}/,
    'the FirstMate dock should receive both the catalog source and current sidebar hint'
  )
  assert.match(
    panel,
    /composePrompt:\s*async \(text\) => \{[\s\S]*?Promise\.all\(projects\.map[\s\S]*?registerProject\(firstMateProjectSelection\(catalogProject\)\)[\s\S]*?firstMateRequest\(requestProjects, project\.id, text, \{[\s\S]*?provider,[\s\S]*?model: captain\.modelId/,
    'FirstMate should receive every registered project plus the active hint without changing its distro cwd'
  )
  const sessionDependencies = conversation.match(/\}, \[options\.cwd[^\]]*\]\)/)?.[0]
  assert.ok(sessionDependencies, 'the ACP session should declare its dependencies')
  assert.doesNotMatch(
    sessionDependencies,
    /composePrompt/,
    'retargeting the next request must not restart the persistent captain conversation'
  )
})

test('shows the active project as a hint for the next FirstMate request', () => {
  const panel = readFileSync(join(process.cwd(), 'src/renderer/src/FirstMatePanel.tsx'), 'utf8')
  const styles = readFileSync(join(process.cwd(), 'src/renderer/src/styles.css'), 'utf8')

  const hint = panel.match(/className="firstmate-project-hint"[\s\S]*?<\/div>/)?.[0]
  assert.ok(hint, 'the dock should show its active-project hint before the captain submits')
  assert.match(hint, /Active hint/, 'the row should identify its non-binding role')
  assert.match(hint, /activeProjectHint\.name/, 'the hint row should name the project')
  assert.match(hint, /activeProjectHint\.windowsPath/, 'the hint row should distinguish similarly named projects by path')
  assert.match(
    hint,
    /title=\{`\$\{activeProjectHint\.windowsPath\}[\s\S]*?registration\.wslPath[\s\S]*?`\}/,
    'the hint shows the registered WSL path, which the renderer never derives itself'
  )
  assert.match(styles, /\.firstmate-project-hint\s*\{/, 'the hint row needs its own style')
})

test('registers every catalog project on the request and keeps mere selection read-only', () => {
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
    panel,
    /Promise\.all\(projects\.map[\s\S]*?registerProject\(firstMateProjectSelection\(catalogProject\)\)/,
    'submission should validate each sidebar project for the machine-readable catalog'
  )
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

test('shows the registered delivery posture of the active project hint', () => {
  const panel = readFileSync(join(process.cwd(), 'src/renderer/src/FirstMatePanel.tsx'), 'utf8')
  const styles = readFileSync(join(process.cwd(), 'src/renderer/src/styles.css'), 'utf8')

  const hint = panel.match(/className="firstmate-project-hint"[\s\S]*?\n          <\/div>/)?.[0]
  assert.ok(hint, 'the dock should still name its active project hint')
  assert.match(hint, /registration\.mode/)
  assert.match(hint, /registration\.autonomy \? ' \+yolo' : ''/)
  assert.match(hint, /registration\.registryName/)
  assert.match(styles, /\.firstmate-project-posture\s*\{/)
})

test('lets the user allow or deny autonomy and explains the posture source', () => {
  const panel = readFileSync(join(process.cwd(), 'src/renderer/src/FirstMatePanel.tsx'), 'utf8')
  const preload = readFileSync(join(process.cwd(), 'src/preload/index.ts'), 'utf8')
  const main = readFileSync(join(process.cwd(), 'src/main/index.ts'), 'utf8')
  const styles = readFileSync(join(process.cwd(), 'src/renderer/src/styles.css'), 'utf8')

  assert.match(panel, /className="firstmate-autonomy-policy"/)
  assert.match(panel, /Allow autonomy/)
  assert.match(panel, /Deny autonomy/)
  assert.match(
    panel,
    /registration\.postureSource === ['"]fleet-registry['"]/,
    'the UI should explain when the fleet registry supplies the standing posture'
  )
  assert.match(
    panel,
    /ADE is vetoing autonomy/,
    'the UI should explain when ADE\'s local policy is vetoing autonomy'
  )
  assert.match(panel, /toggleAutonomyCeiling/)
  assert.match(panel, /window\.firstMateApi\.setAutonomyCeiling\(project\.id/)
  assert.match(preload, /setAutonomyCeiling:[\s\S]*?firstmate:set-autonomy-ceiling/)
  assert.match(
    main,
    /'firstmate:set-autonomy-ceiling'[\s\S]*?typeof adeProjectId === 'string'/,
    'the IPC handler should validate the project identity'
  )
  assert.match(styles, /\.firstmate-autonomy-policy\s*\{/)
})
