import { strict as assert } from 'node:assert'
import { test } from 'vitest'
import { CONVERSATION_CHANNELS } from '../src/shared/ipc-channels'
import { EMPTY_CONVERSATION_PAGE } from '../src/shared/conversation'
import { registerConversationIpc } from '../src/main/conversation-ipc'
import type { ConversationHistory } from '../src/main/conversation-history'
import type { ConversationTitleStore } from '../src/main/conversation-title-store'
import type { ConversationListRequest } from '../src/shared/conversation'
import type { ConversationTitle } from '../src/shared/conversation-title'

interface Harness {
  handlers: Map<string, (...args: unknown[]) => unknown>
  listed: ConversationListRequest[]
  titles: Array<[string, string, string, string]>
}

const storedTitle: ConversationTitle = { title: 'Renamed', source: 'manual' }

function harness(): Harness {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const listed: ConversationListRequest[] = []
  const titles: Array<[string, string, string, string]> = []
  const history: ConversationHistory = {
    list: async (request) => {
      listed.push(request)
      return { entries: [], total: 3, hasMore: true }
    },
    exists: async (path) => path === 'D:/transcripts/one.jsonl'
  }
  const store: ConversationTitleStore = {
    get: async () => null,
    set: async (provider, conversationId, title, source) => {
      titles.push([provider, conversationId, title, source])
      return storedTitle
    }
  }
  registerConversationIpc(
    { handle: (channel, listener) => void handlers.set(channel, listener as (...args: unknown[]) => unknown) },
    history,
    store,
    { contains: async (path) => path.startsWith('D:/p') }
  )
  return { handlers, listed, titles }
}

const event = { sender: {} }

test('a well-formed listing request reaches the history reader with its paging intact', async () => {
  const { handlers, listed } = harness()
  const page = await handlers.get(CONVERSATION_CHANNELS.list)!(event, {
    directories: ['D:/p', 'D:/p-worktrees/fix'],
    limit: 20,
    offset: 40
  })
  assert.deepEqual(page, { entries: [], total: 3, hasMore: true })
  assert.deepEqual(listed, [{ directories: ['D:/p', 'D:/p-worktrees/fix'], limit: 20, offset: 40 }])
})

test('a malformed listing request is answered with the empty page, not a rejection', async () => {
  const { handlers, listed } = harness()
  const handler = handlers.get(CONVERSATION_CHANNELS.list)!
  assert.deepEqual(await handler(event, undefined), EMPTY_CONVERSATION_PAGE)
  assert.deepEqual(await handler(event, { directories: 'D:/p' }), EMPTY_CONVERSATION_PAGE)
  assert.deepEqual(await handler(event, { directories: ['D:/p', 42] }), EMPTY_CONVERSATION_PAGE)
  assert.deepEqual(await handler(event, { directories: ['C:/outside'] }), EMPTY_CONVERSATION_PAGE)
  for (const value of [NaN, Infinity, -1, 1.5, '20', null]) {
    assert.deepEqual(await handler(event, { directories: ['D:/p'], limit: value }), EMPTY_CONVERSATION_PAGE)
    assert.deepEqual(await handler(event, { directories: ['D:/p'], offset: value }), EMPTY_CONVERSATION_PAGE)
  }
  assert.deepEqual(listed, [])
})

test('exists answers false for anything but a string path', async () => {
  const { handlers } = harness()
  const handler = handlers.get(CONVERSATION_CHANNELS.exists)!
  assert.equal(await handler(event, 'D:/transcripts/one.jsonl'), true)
  assert.equal(await handler(event, 'D:/transcripts/gone.jsonl'), false)
  assert.equal(await handler(event, 42), false)
})

test('set-title validates provider, id, title and source before touching the store', async () => {
  const { handlers, titles } = harness()
  const handler = handlers.get(CONVERSATION_CHANNELS.setTitle)!
  assert.equal(await handler(event, 'claude', 'c-1', 'Renamed', 'manual'), storedTitle)
  assert.equal(await handler(event, 'gemini', 'c-1', 'Renamed', 'manual'), null)
  assert.equal(await handler(event, 'claude', 7, 'Renamed', 'manual'), null)
  assert.equal(await handler(event, 'claude', 'c-1', 'Renamed', 'guessed'), null)
  assert.deepEqual(titles, [['claude', 'c-1', 'Renamed', 'manual']])
})
