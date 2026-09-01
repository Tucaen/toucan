import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import type { AgentActivity } from '../src/shared/agent'
import {
  backgroundShellIdFromOutput,
  clampShellOutputBlocks,
  indexShellLaunches,
  normalizeTerminalOutput,
  parseShellExecution,
  shellCommandLine,
  shellExitLabel,
  shellExitTone,
  shellOutputBlocks,
  shellOutputText,
  shellWorkingDirectoryLabel
} from '../src/renderer/src/shell-execution'

// Shell execution tool cards (issue #89). The decisions a card makes about a command - what it
// was, where it ran, how it ended, and what its output says - are all here, so they can be
// pinned against what each adapter actually sends without a DOM.

const ROOT = 'D:\\Development\\Toucan'

function bash(rawInput: Record<string, unknown>, extra: Partial<AgentActivity> = {}): AgentActivity {
  return {
    id: 'b1',
    kind: 'execute',
    toolName: 'Bash',
    title: 'npm test',
    status: 'completed',
    rawInput,
    ...extra
  }
}

test('a Claude Bash call is a run, named by its command', () => {
  const execution = parseShellExecution(bash({ command: 'npm test', description: 'Run the suite' }))
  assert.deepEqual(execution, {
    kind: 'run',
    command: 'npm test',
    background: false,
    description: 'Run the suite'
  })
})

test('a Codex shell call is recognized from its execute kind alone, name and all absent', () => {
  // codex-acp sets neither ACP's `name` nor claude-agent-acp's `_meta.claudeCode.toolName`; the
  // command and the cwd in `rawInput` plus `kind: 'execute'` are all a card gets.
  const execution = parseShellExecution({
    id: 'c1',
    kind: 'execute',
    title: 'npm run lint',
    status: 'completed',
    rawInput: { command: 'bash -lc "npm run lint"', cwd: ROOT }
  })
  assert.equal(execution?.kind, 'run')
  assert.equal(execution?.command, 'bash -lc "npm run lint"')
  assert.equal(execution?.cwd, ROOT)
})

test('an argv-shaped command is one command line', () => {
  const execution = parseShellExecution(bash({ command: ['bash', '-lc', 'ls -la'] }))
  assert.equal(execution?.command, 'bash -lc ls -la')
})

test('the directory the terminal reported outranks the arguments', () => {
  const execution = parseShellExecution(
    bash(
      { command: 'ls', cwd: 'C:\\wrong' },
      {
        terminalCwd: 'D:\\Development\\Toucan\\src'
      }
    )
  )
  assert.equal(execution?.cwd, 'D:\\Development\\Toucan\\src')
})

test('a tool that runs no command keeps the generic card', () => {
  assert.equal(parseShellExecution({ id: 'r1', kind: 'read', toolName: 'Read', rawInput: { file_path: 'a.ts' } }), null)
  // Codex describes a `read file` command action as kind `read` with no command at all.
  assert.equal(parseShellExecution({ id: 'r2', kind: 'read', title: "Read file 'a.ts'", locations: ['a.ts'] }), null)
  // An execute call whose command never arrived would lead with an empty header.
  assert.equal(parseShellExecution({ id: 'e1', kind: 'execute', title: 'Ran a command' }), null)
})

test('the background follow-ups are their own kinds and carry the shell they target', () => {
  const output = parseShellExecution({
    id: 'o1',
    kind: 'execute',
    toolName: 'BashOutput',
    status: 'completed',
    rawInput: { bash_id: 'bash_1' }
  })
  assert.deepEqual(output, { kind: 'output', background: true, shellId: 'bash_1' })

  const kill = parseShellExecution({
    id: 'k1',
    kind: 'execute',
    toolName: 'KillShell',
    status: 'completed',
    rawInput: { shell_id: 'bash_1' }
  })
  assert.deepEqual(kill, { kind: 'kill', background: true, shellId: 'bash_1' })
})

test('a backgrounded run is flagged as one and adopts the shell id it announced', () => {
  const execution = parseShellExecution(
    bash(
      { command: 'npm run dev', run_in_background: true },
      { terminalOutput: 'Command running in background with ID: bash_2' }
    )
  )
  assert.equal(execution?.background, true)
  assert.equal(execution?.shellId, 'bash_2')
})

test('the shell id is only read out of prose that is actually about a background shell', () => {
  assert.equal(backgroundShellIdFromOutput('Command running in background with ID: bash_3'), 'bash_3')
  assert.equal(backgroundShellIdFromOutput(undefined), undefined)
  // A command whose own output happens to mention an id must not be read as a launch.
  assert.equal(backgroundShellIdFromOutput('commit ID: abc123'), undefined)
})

test('the follow-up cards learn their command from the run that launched the shell', () => {
  const launches = indexShellLaunches([
    bash(
      { command: 'npm run dev', run_in_background: true },
      {
        id: 'run-1',
        terminalOutput: 'Command running in background with ID: bash_1'
      }
    ),
    { id: 'out-1', kind: 'execute', toolName: 'BashOutput', rawInput: { bash_id: 'bash_1' } }
  ])
  assert.deepEqual(launches.get('bash_1'), { activityId: 'run-1', command: 'npm run dev' })
  // Nothing is invented for a shell no run in this worklog claimed.
  assert.equal(launches.get('bash_9'), undefined)
})

test('a non-zero exit is visible and reads as a failure; a zero exit reads as a success', () => {
  const failed = parseShellExecution(bash({ command: 'npm test' }, { status: 'failed', exitCode: 1 }))!
  assert.equal(shellExitLabel(failed), 'exit 1')
  assert.equal(shellExitTone(failed, 'failed'), 'error')

  const passed = parseShellExecution(bash({ command: 'npm test' }, { exitCode: 0 }))!
  assert.equal(shellExitLabel(passed), 'exit 0')
  assert.equal(shellExitTone(passed, 'completed'), 'ok')
})

test('a killed command reports its signal rather than the code that was synthesized for it', () => {
  const killed = parseShellExecution(bash({ command: 'sleep 100' }, { exitCode: 0, exitSignal: 'SIGKILL' }))!
  assert.equal(shellExitLabel(killed), 'signal SIGKILL')
  assert.equal(shellExitTone(killed, 'failed'), 'error')
})

test('a still-running command shows no exit chip, and a failure with no reported code still reads as one', () => {
  const running = parseShellExecution(bash({ command: 'npm test' }, { status: 'in_progress' }))!
  assert.equal(shellExitLabel(running), undefined)
  assert.equal(shellExitTone(running, 'in_progress'), undefined)
  assert.equal(shellExitTone(running, 'failed'), 'error')
})

test('a multi-line command becomes one bounded line', () => {
  assert.equal(
    shellCommandLine('git commit -m "$(cat <<EOF\nfix: a thing\nEOF\n)"'),
    'git commit -m "$(cat <<EOF fix: a thing EOF )"'
  )
  const long = shellCommandLine(`echo ${'x'.repeat(500)}`)
  assert.equal(long.length, 220)
  assert.equal(long.endsWith('…'), true)
})

test('the working directory is shown only when it is not the one the node already runs in', () => {
  const roots = [ROOT, 'D:\\Development\\Toucan-main']
  assert.equal(shellWorkingDirectoryLabel(ROOT, roots), undefined)
  // Same checkout, other drive-letter case and other slash: still the node's own directory.
  assert.equal(shellWorkingDirectoryLabel('d:/development/toucan/', roots), undefined)
  assert.equal(shellWorkingDirectoryLabel(`${ROOT}\\src\\main`, roots), 'src/main')
  assert.equal(shellWorkingDirectoryLabel('C:\\elsewhere', roots), 'C:/elsewhere')
  assert.equal(shellWorkingDirectoryLabel(undefined, roots), undefined)
})

test('ANSI colour, cursor moves and progress-bar rewrites never reach the reader', () => {
  assert.equal(normalizeTerminalOutput('\u001B[32mPASS\u001B[0m tests/a.test.ts'), 'PASS tests/a.test.ts')
  assert.equal(normalizeTerminalOutput('\u001B]0;window title\u0007done'), 'done')
  assert.equal(normalizeTerminalOutput('\u001B[2K\u001B[1Gbuilding'), 'building')
  // A download rewriting its line is one line, not a hundred.
  assert.equal(normalizeTerminalOutput('10%\r55%\r100%'), '100%')
  assert.equal(normalizeTerminalOutput('first\r\nsecond\r\n'), 'first\nsecond\n')
})

test('stdout and stderr are labelled apart only when the adapter reported them apart', () => {
  const separated = shellOutputBlocks(
    bash(
      { command: 'npm test' },
      {
        rawOutput: { stdout: 'ok\n', stderr: '1 failing\n', return_code: 1 }
      }
    )
  )
  assert.deepEqual(separated, [
    { stream: 'stdout', lines: ['ok'] },
    { stream: 'stderr', lines: ['1 failing'] }
  ])

  // claude-agent-acp merges the two streams before ACP sees them, so labelling either would lie.
  const merged = shellOutputBlocks(bash({ command: 'npm test' }, { terminalOutput: 'ok\n1 failing\n' }))
  assert.deepEqual(merged, [{ stream: 'output', lines: ['ok', '1 failing'] }])
})

test('output is taken from the terminal channel, then Codex aggregate, then ACP content', () => {
  const activity = bash(
    { command: 'ls' },
    {
      terminalOutput: 'from terminal',
      rawOutput: { formatted_output: 'from raw output' },
      content: 'from content'
    }
  )
  assert.equal(shellOutputText(activity), 'from terminal')
  assert.equal(shellOutputText({ ...activity, terminalOutput: undefined }), 'from raw output')
  assert.equal(shellOutputText({ ...activity, terminalOutput: undefined, rawOutput: undefined }), 'from content')
})

test('an adapter that only sent a fenced code block is unwrapped rather than shown as markdown', () => {
  // What claude-agent-acp falls back to for a replayed session, or a client it thinks cannot take
  // terminal output.
  const activity = bash({ command: 'ls' }, { content: '```console\nsrc\ntests\n```' })
  assert.deepEqual(shellOutputBlocks(activity), [{ stream: 'output', lines: ['src', 'tests'] }])
})

test("ACP's terminal placeholder is not output", () => {
  const activity = bash({ command: 'ls' }, { content: 'Terminal output is available.' })
  assert.deepEqual(shellOutputBlocks(activity), [])
})

test('a huge output is clamped to the budget and the remainder is counted honestly', () => {
  const blocks = shellOutputBlocks(
    bash(
      { command: 'npm test' },
      {
        rawOutput: {
          stdout: Array.from({ length: 30 }, (_, index) => `out ${index}`).join('\n'),
          stderr: Array.from({ length: 30 }, (_, index) => `err ${index}`).join('\n')
        }
      }
    )
  )
  const clamped = clampShellOutputBlocks(blocks, 40)
  assert.equal(clamped.blocks.length, 2)
  assert.equal(clamped.blocks[0].lines.length, 30)
  assert.equal(clamped.blocks[1].lines.length, 10)
  assert.equal(clamped.hiddenLines, 20)
  assert.equal(clampShellOutputBlocks(blocks, null).hiddenLines, 0)
})
