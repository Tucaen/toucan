import { strict as assert } from 'node:assert'
import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'
import { PROJECT_SKILLS_DIRECTORY } from '../src/shared/project-skills'
import {
  SESSION_RECORDS_CLI_PATH,
  renderSessionOutcome,
  sessionOutcomeFileName,
  type SessionOutcomeRecord
} from '../src/shared/session-outcome'

// The agent-facing query over outcome records: one JSON line, filters AND together, the project
// defaults to the caller's checkout, and a hit carries only the sections that matched.

const cli = join(process.cwd(), PROJECT_SKILLS_DIRECTORY, ...SESSION_RECORDS_CLI_PATH)

interface Hit {
  file: string
  title: string
  project: string
  updated: string
  sections?: Record<string, string>
  [key: string]: unknown
}
interface Output {
  ok: boolean
  error?: string
  project: string | null
  total: number
  returned: number
  more?: number
  records: Hit[]
}

function run(args: string[], cwd: string): Promise<{ code: number; output: Output; raw: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [cli, ...args], { cwd }, (error, stdout) => {
      const raw = stdout.trim()
      resolve({ code: error ? Number((error as { code?: number }).code ?? 1) : 0, output: JSON.parse(raw), raw })
    })
  })
}

function record(overrides: Partial<SessionOutcomeRecord> & { conversationId: string }): SessionOutcomeRecord {
  return {
    key: `claude-${overrides.conversationId}`,
    provider: 'claude',
    projectPath: 'D:\\Dev\\alpha',
    title: 'Some work',
    task: 'Do the thing.',
    asks: ['Do the thing.'],
    asksOmitted: 0,
    lastResult: 'Done.',
    turns: 2,
    filesTouched: [],
    filesOmitted: 0,
    failures: [],
    toolFailures: [],
    toolFailuresOmitted: 0,
    status: 'completed',
    startedAt: '2026-10-01T10:00:00.000Z',
    updatedAt: '2026-10-01T11:00:00.000Z',
    ...overrides
  }
}

function fixture(records: SessionOutcomeRecord[]): string {
  const directory = mkdtempSync(join(tmpdir(), 'toucan-session-records-'))
  for (const entry of records) {
    writeFileSync(join(directory, `${sessionOutcomeFileName(entry)}.md`), renderSessionOutcome(entry))
  }
  return directory
}

/** A cwd that is no git checkout, named for the project the records belong to. */
function checkout(name: string): string {
  const cwd = join(mkdtempSync(join(tmpdir(), 'toucan-cwd-')), name)
  mkdirSync(cwd)
  return cwd
}

const records = [
  record({
    conversationId: 'aaaaaaaa-1',
    title: 'Fix the parser',
    filesTouched: ['src/parser.ts', 'tests/parser.test.ts'],
    failures: [{ id: 't1', status: 'failed', message: 'Typecheck failed: 2 errors' }],
    toolFailures: ['npm test — exit 1'],
    startedAt: '2026-10-01T10:00:00.000Z',
    updatedAt: '2026-10-02T10:00:00.000Z'
  }),
  record({
    conversationId: 'bbbbbbbb-2',
    title: 'Add the CLI',
    filesTouched: ['src/cli.ts', 'src/parser.ts'],
    toolFailures: ['git push — signal SIGTERM'],
    startedAt: '2026-10-05T10:00:00.000Z',
    updatedAt: '2026-10-06T10:00:00.000Z'
  }),
  record({
    conversationId: 'cccccccc-3',
    title: 'Docs pass',
    filesTouched: ['README.md'],
    startedAt: '2026-10-10T10:00:00.000Z',
    updatedAt: '2026-10-11T10:00:00.000Z'
  }),
  record({
    conversationId: 'dddddddd-4',
    title: 'Fix the parser elsewhere',
    projectPath: 'D:\\Dev\\beta',
    filesTouched: ['src/parser.ts'],
    updatedAt: '2026-10-12T10:00:00.000Z'
  })
]
const directory = fixture(records)
const alpha = checkout('alpha')

const titles = (hits: Hit[]): string[] => hits.map((hit) => hit.title)

test('defaults to the current checkout project, newest first, and can be widened or retargeted', async () => {
  const scoped = await run(['--dir', directory], alpha)
  assert.equal(scoped.output.project, 'alpha')
  assert.deepEqual(titles(scoped.output.records), ['Docs pass', 'Add the CLI', 'Fix the parser'])

  const all = await run(['--dir', directory, '--all-projects'], alpha)
  assert.equal(all.output.project, null)
  assert.equal(all.output.total, 4)
  assert.equal(all.output.records[0]?.title, 'Fix the parser elsewhere')

  const beta = await run(['--dir', directory, '--project', 'D:\\Dev\\beta'], alpha)
  assert.deepEqual(titles(beta.output.records), ['Fix the parser elsewhere'])
})

test('--file matches written files and returns only the matching lines of that section', async () => {
  const { output } = await run(['--dir', directory, '--file', 'parser'], alpha)
  assert.deepEqual(titles(output.records), ['Add the CLI', 'Fix the parser'])
  assert.deepEqual(output.records[0]?.sections, { files: '- src/parser.ts' })
  assert.deepEqual(output.records[1]?.sections, { files: '- src/parser.ts\n- tests/parser.test.ts' })
})

test('--failure searches turn failures and tool failures, returning only the sections that matched', async () => {
  const turn = await run(['--dir', directory, '--failure', 'typecheck'], alpha)
  assert.deepEqual(titles(turn.output.records), ['Fix the parser'])
  assert.deepEqual(Object.keys(turn.output.records[0]?.sections ?? {}), ['failures'])

  const tool = await run(['--dir', directory, '--failure', 'sigterm'], alpha)
  assert.deepEqual(titles(tool.output.records), ['Add the CLI'])
  assert.deepEqual(Object.keys(tool.output.records[0]?.sections ?? {}), ['tool-failures'])
})

test('--title is a case-insensitive substring match and adds no body section', async () => {
  const { output } = await run(['--dir', directory, '--title', 'FIX THE'], alpha)
  assert.deepEqual(titles(output.records), ['Fix the parser'])
  assert.equal(output.records[0]?.sections, undefined)
})

test('date filters range over started and updated, and a bare until date includes its whole day', async () => {
  const started = await run(
    ['--dir', directory, '--started-since', '2026-10-05', '--started-until', '2026-10-05'],
    alpha
  )
  assert.deepEqual(titles(started.output.records), ['Add the CLI'])

  const updated = await run(['--dir', directory, '--updated-until', '2026-10-06'], alpha)
  assert.deepEqual(titles(updated.output.records), ['Add the CLI', 'Fix the parser'])

  const since = await run(['--dir', directory, '--updated-since', '2026-10-11T00:00:00Z'], alpha)
  assert.deepEqual(titles(since.output.records), ['Docs pass'])
})

test('filters combine with AND, including across project scope', async () => {
  const both = await run(['--dir', directory, '--file', 'parser', '--updated-since', '2026-10-05'], alpha)
  assert.deepEqual(titles(both.output.records), ['Add the CLI'])

  const none = await run(['--dir', directory, '--file', 'parser', '--failure', 'sigterm', '--title', 'parser'], alpha)
  assert.equal(none.output.total, 0)

  const widened = await run(['--dir', directory, '--all-projects', '--file', 'parser', '--title', 'elsewhere'], alpha)
  assert.deepEqual(titles(widened.output.records), ['Fix the parser elsewhere'])
})

test('a hit is the frontmatter plus the file name; --include adds whole sections on request', async () => {
  const { output } = await run(['--dir', directory, '--title', 'docs', '--include', 'task,files'], alpha)
  const [hit] = output.records
  assert.ok(hit)
  assert.match(hit.file, /^alpha--docs-pass--cccccccc\.md$/)
  assert.equal(hit.key, 'claude-cccccccc-3')
  assert.equal(hit.project, 'D:\\Dev\\alpha')
  assert.equal(hit.status, 'completed')
  assert.equal(hit.turns, 2)
  assert.deepEqual(hit.sections, { task: 'Do the thing.', files: '- README.md' })
})

test('the limit defaults to ten, reports what it left out, and rejects nonsense', async () => {
  const many = fixture(
    Array.from({ length: 12 }, (_, index) =>
      record({
        conversationId: `eeeeeeee-${index}`,
        title: `Run ${index}`,
        updatedAt: `2026-10-${String(index + 1).padStart(2, '0')}T10:00:00.000Z`
      })
    )
  )
  const page = await run(['--dir', many], alpha)
  assert.equal(page.output.total, 12)
  assert.equal(page.output.returned, 10)
  assert.equal(page.output.more, 2)
  assert.equal(page.output.records[0]?.title, 'Run 11')

  const one = await run(['--dir', many, '--limit', '1'], alpha)
  assert.equal(one.output.returned, 1)

  const bad = await run(['--dir', many, '--limit', '0'], alpha)
  assert.equal(bad.code, 2)
  assert.equal(bad.output.ok, false)
})

test('usage errors and a missing folder are answered in one JSON line', async () => {
  assert.equal((await run([], alpha)).code, 2)
  assert.equal((await run(['--dir', directory, '--bogus', 'x'], alpha)).code, 2)
  assert.equal((await run(['--dir', directory, '--updated-since', 'soon'], alpha)).code, 2)
  assert.equal((await run(['--dir', directory, '--include', 'nope'], alpha)).code, 2)
  assert.equal((await run(['--dir', directory, '--all-projects', '--project', 'x'], alpha)).code, 2)

  const missing = await run(['--dir', join(directory, 'nowhere')], alpha)
  assert.equal(missing.code, 0)
  assert.equal(missing.output.total, 0)
})
