import { strict as assert } from 'node:assert'
import * as childProcess from 'node:child_process'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import { runClaudeCleanup } from '../src/main/claude-dictation-cleanup'

test('cleanup launches a hidden, nonpersistent, tool-free Claude turn with subscription auth', async (t) => {
  const oldKey = process.env.ANTHROPIC_API_KEY
  const oldRoute = process.env.CLAUDE_CODE_USE_BEDROCK
  process.env.ANTHROPIC_API_KEY = 'must-not-use-api-billing'
  process.env.CLAUDE_CODE_USE_BEDROCK = '1'
  t.after(() => {
    if (oldKey === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = oldKey
    if (oldRoute === undefined) delete process.env.CLAUDE_CODE_USE_BEDROCK
    else process.env.CLAUDE_CODE_USE_BEDROCK = oldRoute
  })
  let input = ''
  const signal = new AbortController().signal
  t.mock.method(childProcess, 'execFile', ((
    file: string,
    args: string[],
    options: childProcess.ExecFileOptions,
    done: (error: null, stdout: string) => void
  ) => {
    assert.match(file, /claude(?:\.exe)?$/)
    assert.equal(options.windowsHide, true)
    assert.equal(options.signal, signal)
    assert.equal(options.killSignal, 'SIGKILL')
    assert.equal(options.env?.ANTHROPIC_API_KEY, undefined)
    assert.equal(options.env?.CLAUDE_CODE_USE_BEDROCK, undefined)
    for (const flag of [
      '-p',
      '--safe-mode',
      '--no-session-persistence',
      '--strict-mcp-config',
      '--disable-slash-commands'
    ])
      assert.ok(args.includes(flag), flag)
    assert.equal(args[args.indexOf('--model') + 1], 'haiku')
    assert.equal(args[args.indexOf('--tools') + 1], '')
    assert.equal(args[args.indexOf('--setting-sources') + 1], '')
    assert.equal(args.includes('private dictation'), false)
    const stdin = new PassThrough()
    stdin.on('data', (chunk) => {
      input += chunk.toString()
    })
    stdin.on('finish', () => done(null, 'response'))
    return { stdin }
  }) as unknown as typeof childProcess.execFile)
  assert.equal(await runClaudeCleanup('private dictation', 'haiku', signal), 'response')
  assert.equal(input, 'private dictation')
})
