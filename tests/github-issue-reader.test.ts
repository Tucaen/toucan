import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { createGithubIssueReader, type GithubCommandRunner } from '../src/main/github-issues'
import { GITHUB_ISSUE_FIELDS } from '../src/shared/github-issues'

/**
 * The impure half: which commands run, in which order, and - the part that matters most - that a
 * machine without `gh`, a project that is not on GitHub, and a `gh` nobody signed in to all come
 * back as an answer the board can render. Nothing here may throw into the UI.
 */

const PROJECT = 'D:\\Development\\Toucan'
const SHIM = 'C:\\Users\\dev\\AppData\\Roaming\\npm\\gh.cmd'
const NATIVE = 'C:\\Users\\dev\\AppData\\Roaming\\npm\\gh.exe'
const REMOTES = 'origin\thttps://github.com/tucaen/toucan.git (fetch)\n'
const ISSUES = JSON.stringify([
  { number: 147, title: 'GitHub issues', state: 'OPEN', updatedAt: '2026-09-04T14:50:06Z', labels: [] }
])

interface Call {
  command: string
  args: string[]
  cwd: string
}

type Stub = { code?: number; stdout?: string; stderr?: string }

/**
 * Responses are keyed by command and first argument (`gh auth`, `gh issue`), because telling the
 * sign-in check apart from the listing is exactly what most of these tests turn on.
 */
function reader(
  responses: Record<string, Stub>,
  options: { resolves?: (command: string) => string | null; exists?: (path: string) => boolean } = {}
): { reader: ReturnType<typeof createGithubIssueReader>; calls: Call[] } {
  const calls: Call[] = []
  const run: GithubCommandRunner = async (command, args, cwd) => {
    calls.push({ command, args, cwd })
    const response = responses[`${command} ${args[0]}`] ??
      responses[command] ?? { code: 1, stderr: `no stub for ${command} ${args[0]}` }
    return { code: response.code ?? 0, stdout: response.stdout ?? '', stderr: response.stderr ?? '' }
  }
  return {
    calls,
    reader: createGithubIssueReader({
      run,
      resolveCommand: options.resolves ?? ((command) => command),
      pathExists: options.exists ?? (() => false),
      // Every test wants the commands it stubbed to actually run, not a probe cached by its neighbour.
      probeTtlMs: 0
    })
  }
}

/** The happy path every test that is not about the probe starts from. */
const READY: Record<string, Stub> = { git: { stdout: REMOTES }, 'gh auth': {}, 'gh issue': { stdout: ISSUES } }

test('a machine without the GitHub CLI reports why, and launches nothing', async () => {
  const { reader: github, calls } = reader({}, { resolves: (command) => (command === 'gh' ? null : command) })
  const expected = {
    available: false,
    reason: 'The GitHub CLI (gh) was not found. Install it to see this project’s issues.'
  }
  assert.deepEqual(await github.availability(PROJECT), expected)
  assert.deepEqual(await github.list(PROJECT), expected)
  assert.deepEqual(calls, [])
})

test('a checkout with no GitHub remote is unavailable without ever asking gh', async () => {
  const { reader: github, calls } = reader({ git: { stdout: 'origin\thttps://gitlab.com/a/b.git (fetch)\n' } })
  assert.deepEqual(await github.availability(PROJECT), {
    available: false,
    reason: 'This project has no GitHub remote.'
  })
  assert.deepEqual(
    calls.map((call) => call.command),
    ['git']
  )
})

test('a folder git cannot read is unavailable rather than an error the board has to catch', async () => {
  const { reader: github } = reader({ git: { code: 128, stderr: 'not a git repository' } })
  assert.deepEqual(await github.availability(PROJECT), {
    available: false,
    reason: 'This project has no GitHub remote.'
  })
})

test('a gh nobody signed in to is unavailable before the source is ever offered', async () => {
  const { reader: github, calls } = reader({
    git: { stdout: REMOTES },
    'gh auth': { code: 1, stderr: 'gh: To get started with GitHub CLI, please run: gh auth login\n' }
  })
  assert.deepEqual(await github.availability(PROJECT), {
    available: false,
    reason: 'gh: To get started with GitHub CLI, please run: gh auth login'
  })
  // The sign-in check must not have been followed by a listing nobody could have used.
  assert.deepEqual(
    calls.map((call) => `${call.command} ${call.args[0]}`),
    ['git remote', 'gh auth']
  )
})

test('a sign-in failure with nothing to say still names the command that fixes it', async () => {
  const { reader: github } = reader({ git: { stdout: REMOTES }, 'gh auth': { code: 1 } })
  assert.deepEqual(await github.availability(PROJECT), {
    available: false,
    reason: 'The GitHub CLI is not signed in. Run gh auth login.'
  })
})

test('a GitHub checkout is available, and lists its issues as cards', async () => {
  const { reader: github, calls } = reader(READY)
  assert.deepEqual(await github.availability(PROJECT), { available: true, detail: 'tucaen/toucan' })

  const listed = await github.list(PROJECT)
  assert.ok(listed.available)
  assert.deepEqual(
    listed.cards.map((card) => [card.sourceId, card.id, card.status]),
    [['github', '147', 'open']]
  )
  assert.deepEqual(listed.diagnostics, [])

  const issueCall = calls.find((call) => call.args[0] === 'issue')
  assert.ok(issueCall)
  assert.equal(issueCall.cwd, PROJECT)
  assert.deepEqual(issueCall.args, [
    'issue',
    'list',
    '--state',
    'all',
    '--json',
    GITHUB_ISSUE_FIELDS.join(','),
    '--limit',
    '200'
  ])
})

test('a gh that exits non-zero hands its own words to the board', async () => {
  const { reader: github } = reader({
    ...READY,
    'gh issue': { code: 4, stderr: 'gh: this repository has issues disabled\n' }
  })
  assert.deepEqual(await github.list(PROJECT), {
    available: false,
    reason: 'gh: this repository has issues disabled'
  })
})

test('a gh that fails silently still says something a person can act on', async () => {
  const { reader: github } = reader({ ...READY, 'gh issue': { code: 1 } })
  const listed = await github.list(PROJECT)
  assert.ok(!listed.available && listed.reason.includes('gh issue list'))
})

test('the resolved gh path is what runs, so a CLI outside PATH still works', async () => {
  const { reader: github, calls } = reader(
    { git: { stdout: REMOTES }, 'C:\\tools\\gh.exe auth': {}, 'C:\\tools\\gh.exe issue': { stdout: '[]' } },
    { resolves: (command) => (command === 'gh' ? 'C:\\tools\\gh.exe' : command) }
  )
  await github.list(PROJECT)
  assert.ok(calls.some((call) => call.command === 'C:\\tools\\gh.exe'))
})

test('a .cmd shim is launched as the native executable beside it, which execFile can run', async () => {
  const { reader: github, calls } = reader(
    { git: { stdout: REMOTES }, [`${NATIVE} auth`]: {}, [`${NATIVE} issue`]: { stdout: '[]' } },
    { resolves: (command) => (command === 'gh' ? SHIM : command), exists: (path) => path === NATIVE }
  )
  await github.list(PROJECT)
  assert.ok(calls.every((call) => call.command !== SHIM))
  assert.ok(calls.some((call) => call.command === NATIVE))
})

test('a shim with no native sibling is still tried, because refusing outright helps nobody', async () => {
  const { reader: github, calls } = reader(
    { git: { stdout: REMOTES }, [`${SHIM} auth`]: {}, [`${SHIM} issue`]: { stdout: '[]' } },
    { resolves: (command) => (command === 'gh' ? SHIM : command) }
  )
  assert.equal((await github.list(PROJECT)).available, true)
  assert.ok(calls.some((call) => call.command === SHIM))
})

test('a listing straight after a probe reuses it instead of re-asking the machine', async () => {
  const calls: Call[] = []
  const github = createGithubIssueReader({
    resolveCommand: (command) => command,
    pathExists: () => false,
    run: async (command, args, cwd) => {
      calls.push({ command, args, cwd })
      return { code: 0, stdout: args[0] === 'remote' ? REMOTES : ISSUES, stderr: '' }
    }
  })
  await github.availability(PROJECT)
  await github.list(PROJECT)
  assert.deepEqual(
    calls.map((call) => `${call.command} ${call.args[0]}`),
    ['git remote', 'gh auth', 'gh issue']
  )
})
