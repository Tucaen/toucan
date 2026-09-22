import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'
import { createConversationHistory, encodeClaudeProjectDirectory } from '../src/main/conversation-history'
import { createConversationTitleStore } from '../src/main/conversation-title-store'

const PROJECT = 'D:\\Dev\\Toucan'
const WORKTREE = 'D:\\Dev\\Toucan-worktrees\\feature'

function makeHome(): string {
  return mkdtempSync(join(tmpdir(), 'toucan-history-'))
}

function history(home: string): ReturnType<typeof createConversationHistory> {
  return createConversationHistory({ homeDirectory: home, environment: {} })
}

function writeClaudeTranscript(options: {
  home: string
  /** The on-disk project directory name, which is not always the encoding of `cwd` verbatim. */
  directoryName: string
  id: string
  title?: string
  turns: Array<{ role: 'user' | 'assistant'; text: string; sidechain?: boolean }>
  mtimeSeconds: number
}): string {
  const directory = join(options.home, '.claude', 'projects', options.directoryName)
  mkdirSync(directory, { recursive: true })
  const lines: string[] = []
  if (options.title) {
    lines.push(JSON.stringify({ type: 'ai-title', aiTitle: options.title, sessionId: options.id }))
  }
  options.turns.forEach((turn, index) => {
    lines.push(
      JSON.stringify({
        type: turn.role,
        isSidechain: turn.sidechain ?? false,
        timestamp: `2026-08-20T10:0${index}:00.000Z`,
        message: { role: turn.role, content: [{ type: 'text', text: turn.text }] }
      })
    )
  })
  const path = join(directory, `${options.id}.jsonl`)
  writeFileSync(path, `${lines.join('\n')}\n`)
  utimesSync(path, options.mtimeSeconds, options.mtimeSeconds)
  return path
}

function writeCodexTranscript(options: {
  home: string
  id: string
  cwd: string
  day: string
  subagent?: boolean
  turns: Array<{ role: 'user' | 'assistant'; text: string }>
  mtimeSeconds: number
  /** Pads the session_meta line past the head read, as real base instructions do. */
  oversizedMeta?: boolean
}): string {
  const directory = join(options.home, '.codex', 'sessions', '2026', '08', options.day)
  mkdirSync(directory, { recursive: true })
  const meta = {
    timestamp: '2026-08-20T10:00:00.000Z',
    type: 'session_meta',
    payload: {
      session_id: options.id,
      id: options.id,
      cwd: options.cwd,
      timestamp: '2026-08-20T10:00:00.000Z',
      thread_source: options.subagent ? 'subagent' : 'user',
      ...(options.oversizedMeta ? { base_instructions: { text: 'x'.repeat(32 * 1024) } } : {})
    }
  }
  const lines = [JSON.stringify(meta)]
  options.turns.forEach((turn, index) => {
    lines.push(
      JSON.stringify({
        timestamp: `2026-08-20T10:0${index}:00.000Z`,
        type: 'response_item',
        payload: {
          type: 'message',
          role: turn.role,
          content: [{ type: turn.role === 'user' ? 'input_text' : 'output_text', text: turn.text }]
        }
      })
    )
  })
  const path = join(directory, `rollout-2026-08-${options.day}T10-00-00-${options.id}.jsonl`)
  writeFileSync(path, `${lines.join('\n')}\n`)
  utimesSync(path, options.mtimeSeconds, options.mtimeSeconds)
  return path
}

test('encodes a working directory the way Claude names its project folder', () => {
  assert.equal(encodeClaudeProjectDirectory('d:\\Development\\Toucan'), 'd--Development-Toucan')
})

test('lists both providers for a directory, newest first', async () => {
  const home = makeHome()
  try {
    writeClaudeTranscript({
      home,
      directoryName: encodeClaudeProjectDirectory(PROJECT),
      id: 'claude-old',
      title: 'Rename the parser',
      turns: [
        { role: 'user', text: 'rename it' },
        { role: 'assistant', text: 'done' }
      ],
      mtimeSeconds: 1_700_000_000
    })
    writeCodexTranscript({
      home,
      id: 'codex-new',
      cwd: PROJECT,
      day: '21',
      turns: [
        { role: 'user', text: 'ship the release' },
        { role: 'assistant', text: 'shipped' }
      ],
      mtimeSeconds: 1_700_000_500
    })

    const page = await history(home).list({ directories: [PROJECT] })

    assert.equal(page.total, 2)
    assert.equal(page.hasMore, false)
    assert.deepEqual(
      page.entries.map((entry) => entry.id),
      ['codex-new', 'claude-old']
    )
    assert.deepEqual(
      page.entries.map((entry) => entry.provider),
      ['codex', 'claude']
    )
    assert.deepEqual(
      page.entries.map((entry) => entry.title),
      ['ship the release', 'Rename the parser']
    )
    assert.deepEqual(
      page.entries.map((entry) => entry.messageCount),
      [2, 2]
    )
    assert.deepEqual(
      page.entries.map((entry) => entry.cwd),
      [PROJECT, PROJECT]
    )
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('a durable title overrides provider and first-message titles in history', async () => {
  const home = makeHome()
  try {
    writeClaudeTranscript({
      home,
      directoryName: encodeClaudeProjectDirectory(PROJECT),
      id: 'claude-renamed',
      title: 'Provider title',
      turns: [
        { role: 'user', text: 'continue' },
        { role: 'assistant', text: 'Working on recovery.' }
      ],
      mtimeSeconds: 1_700_000_000
    })
    const titles = createConversationTitleStore(join(home, 'titles.json'))
    await titles.set('claude', 'claude-renamed', 'Crash-safe workspace recovery', 'manual')

    const page = await createConversationHistory({
      homeDirectory: home,
      environment: {},
      titles
    }).list({ directories: [PROJECT] })

    assert.equal(page.entries[0].title, 'Crash-safe workspace recovery')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('matches a Claude project folder whose drive letter case differs from the request', async () => {
  const home = makeHome()
  try {
    writeClaudeTranscript({
      home,
      directoryName: 'd--Dev-Toucan',
      id: 'claude-1',
      turns: [{ role: 'user', text: 'hello' }],
      mtimeSeconds: 1_700_000_000
    })

    const page = await history(home).list({ directories: ['D:\\Dev\\Toucan'] })

    assert.deepEqual(
      page.entries.map((entry) => entry.id),
      ['claude-1']
    )
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('titles a conversation from the first typed turn, not an injected context block', async () => {
  const home = makeHome()
  try {
    writeCodexTranscript({
      home,
      id: 'codex-1',
      cwd: PROJECT,
      day: '21',
      turns: [
        { role: 'user', text: '<environment_context>cwd=D:\\Dev\\Toucan</environment_context>' },
        { role: 'user', text: 'compare Toucan to orca' }
      ],
      mtimeSeconds: 1_700_000_000
    })

    const page = await history(home).list({ directories: [PROJECT] })

    assert.equal(page.entries[0].title, 'compare Toucan to orca')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('ignores Codex subagent rollouts and transcripts from other directories', async () => {
  const home = makeHome()
  try {
    writeCodexTranscript({
      home,
      id: 'codex-subagent',
      cwd: PROJECT,
      day: '21',
      subagent: true,
      turns: [{ role: 'user', text: 'judge this action' }],
      mtimeSeconds: 1_700_000_900
    })
    writeCodexTranscript({
      home,
      id: 'codex-elsewhere',
      cwd: 'D:\\Dev\\Other',
      day: '21',
      turns: [{ role: 'user', text: 'unrelated' }],
      mtimeSeconds: 1_700_000_800
    })
    writeCodexTranscript({
      home,
      id: 'codex-worktree',
      cwd: WORKTREE,
      day: '21',
      turns: [{ role: 'user', text: 'on the branch' }],
      mtimeSeconds: 1_700_000_700
    })

    const page = await history(home).list({ directories: [PROJECT, WORKTREE] })

    assert.deepEqual(
      page.entries.map((entry) => entry.id),
      ['codex-worktree']
    )
    assert.equal(page.entries[0].cwd, WORKTREE)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('reads a Codex session whose meta line outruns the head read', async () => {
  const home = makeHome()
  try {
    writeCodexTranscript({
      home,
      id: 'codex-big-meta',
      cwd: PROJECT,
      day: '21',
      oversizedMeta: true,
      turns: [{ role: 'user', text: 'still findable' }],
      mtimeSeconds: 1_700_000_000
    })

    const page = await history(home).list({ directories: [PROJECT] })

    assert.deepEqual(
      page.entries.map((entry) => entry.id),
      ['codex-big-meta']
    )
    assert.equal(page.entries[0].title, 'still findable')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('counts user and assistant turns only, skipping sidechains', async () => {
  const home = makeHome()
  try {
    writeClaudeTranscript({
      home,
      directoryName: encodeClaudeProjectDirectory(PROJECT),
      id: 'claude-1',
      turns: [
        { role: 'user', text: 'do it' },
        { role: 'assistant', text: 'working' },
        { role: 'assistant', text: 'subagent chatter', sidechain: true },
        { role: 'assistant', text: 'done' }
      ],
      mtimeSeconds: 1_700_000_000
    })

    const page = await history(home).list({ directories: [PROJECT] })

    assert.equal(page.entries[0].messageCount, 3)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('pages a long history instead of reading every transcript', async () => {
  const home = makeHome()
  try {
    for (let index = 0; index < 220; index += 1) {
      writeClaudeTranscript({
        home,
        directoryName: encodeClaudeProjectDirectory(PROJECT),
        id: `claude-${String(index).padStart(3, '0')}`,
        title: `Conversation ${index}`,
        turns: [{ role: 'user', text: 'hello' }],
        mtimeSeconds: 1_700_000_000 + index
      })
    }
    const browser = history(home)

    const first = await browser.list({ directories: [PROJECT], limit: 25 })
    assert.equal(first.total, 220)
    assert.equal(first.entries.length, 25)
    assert.equal(first.hasMore, true)
    assert.equal(first.entries[0].title, 'Conversation 219')

    const last = await browser.list({ directories: [PROJECT], limit: 25, offset: 200 })
    assert.equal(last.entries.length, 20)
    assert.equal(last.hasMore, false)
    assert.equal(last.entries.at(-1)!.title, 'Conversation 0')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('reports a transcript deleted after it was listed', async () => {
  const home = makeHome()
  try {
    const path = writeClaudeTranscript({
      home,
      directoryName: encodeClaudeProjectDirectory(PROJECT),
      id: 'claude-1',
      turns: [{ role: 'user', text: 'hello' }],
      mtimeSeconds: 1_700_000_000
    })
    const browser = history(home)

    assert.equal(await browser.exists(path), true)
    rmSync(path)
    assert.equal(await browser.exists(path), false)
    assert.deepEqual((await browser.list({ directories: [PROJECT] })).entries, [])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('returns nothing when no directory is given', async () => {
  const home = makeHome()
  try {
    assert.deepEqual(await history(home).list({ directories: [] }), { entries: [], total: 0, hasMore: false })
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
