import { strict as assert } from 'node:assert'
import type * as childProcess from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { test, vi } from 'vitest'
import { runClaudeCleanup } from '../src/main/claude-dictation-cleanup'

/**
 * `execFile` is replaced at the module boundary rather than spied on the namespace object: an ESM
 * namespace is not configurable, so `vi.spyOn(childProcess, 'execFile')` throws, and the module
 * under test holds a direct binding a namespace patch would not reach anyway.
 */
const execFile = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', async (importActual) => ({
  ...(await importActual<typeof childProcess>()),
  execFile
}))

test('cleanup launches a hidden, nonpersistent, tool-free Claude turn with subscription auth', async (t) => {
  const oldKey = process.env.ANTHROPIC_API_KEY
  const oldRoute = process.env.CLAUDE_CODE_USE_BEDROCK
  const oldThinking = process.env.MAX_THINKING_TOKENS
  process.env.ANTHROPIC_API_KEY = 'must-not-use-api-billing'
  process.env.CLAUDE_CODE_USE_BEDROCK = '1'
  process.env.MAX_THINKING_TOKENS = '31999'
  t.onTestFinished(() => {
    if (oldKey === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = oldKey
    if (oldRoute === undefined) delete process.env.CLAUDE_CODE_USE_BEDROCK
    else process.env.CLAUDE_CODE_USE_BEDROCK = oldRoute
    if (oldThinking === undefined) delete process.env.MAX_THINKING_TOKENS
    else process.env.MAX_THINKING_TOKENS = oldThinking
  })
  let input = ''
  const signal = new AbortController().signal
  execFile.mockImplementation(((
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
    // Thinking triples the wall clock on a task that is not reasoning; the cleanup deadline assumes
    // it stays off, and an inherited value must not win.
    assert.equal(options.env?.MAX_THINKING_TOKENS, '0')
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

test('a failed launch reports a cancellation or a sign-in problem, never the command', async () => {
  for (const [aborted, expected] of [
    [false, /sign-in and allowance/],
    [true, /^Cleanup cancelled\.$/]
  ] as const) {
    const controller = new AbortController()
    if (aborted) controller.abort()
    execFile.mockImplementation(((
      _file: string,
      _args: string[],
      _options: childProcess.ExecFileOptions,
      done: (error: Error, stdout: string) => void
    ) => {
      const stdin = new PassThrough()
      // execFile hands back an error whose message carries the whole command line, system prompt
      // and all; the rejection the renderer shows must not be built from it.
      stdin.on('finish', () => done(new Error('Command failed: claude -p --system-prompt Polish the...'), ''))
      return { stdin }
    }) as unknown as typeof childProcess.execFile)
    await assert.rejects(runClaudeCleanup('private dictation', 'haiku', controller.signal), (error: Error) => {
      assert.match(error.message, expected)
      assert.equal(error.message.includes('private dictation'), false)
      assert.equal(/system-prompt|Polish/.test(error.message), false)
      return true
    })
  }
})

test('the relocated Claude config root reaches the turn that has to find the same install', async (t) => {
  const old = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = join(tmpdir(), 'relocated-claude')
  t.onTestFinished(() => {
    if (old === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = old
  })
  let configRoot: string | undefined
  execFile.mockImplementation(((
    _file: string,
    _args: string[],
    options: childProcess.ExecFileOptions,
    done: (error: null, stdout: string) => void
  ) => {
    configRoot = options.env?.CLAUDE_CONFIG_DIR
    const stdin = new PassThrough()
    stdin.on('finish', () => done(null, 'response'))
    return { stdin }
  }) as unknown as typeof childProcess.execFile)
  await runClaudeCleanup('private dictation', 'haiku', new AbortController().signal)
  assert.equal(configRoot, join(tmpdir(), 'relocated-claude'))
})
