import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import {
  ATTENTION_COALESCE_WINDOW_MS,
  ATTENTION_ITEM_LIMIT,
  ATTENTION_NODE_ITEM_LIMIT,
  applyAttentionAction,
  attentionItemId,
  countUnreadAttention,
  dominantUnreadKind,
  forgetAttention,
  isAttentionItem,
  markAttentionRead,
  markAttentionUnread,
  pruneAttention,
  READ_ON_VIEW_KINDS,
  recordAttention,
  resolveAttention,
  unreadAttentionByNode,
  unreadAttentionKinds,
  type AttentionSignal,
  type AttentionState
} from '../src/shared/attention'

const T0 = 1_700_000_000_000

function approval(nodeId: string, key: string, at: number): AttentionSignal {
  return { nodeId, kind: 'approval', key, at, sourceId: `${nodeId}-session` }
}

describe('attention records', () => {
  test('an actionable event becomes one unread record identified by its source and condition', () => {
    const state = recordAttention([], approval('node-1', 'perm-7', T0))

    assert.equal(state.length, 1)
    assert.equal(state[0].id, attentionItemId('node-1', 'approval', 'perm-7'))
    assert.equal(state[0].nodeId, 'node-1')
    assert.equal(state[0].sourceId, 'node-1-session')
    assert.equal(state[0].read, false)
  })

  test('a replayed event for the same condition does not create a second record', () => {
    const first = recordAttention([], approval('node-1', 'perm-7', T0))
    const replayed = recordAttention(first, approval('node-1', 'perm-7', T0 + 60_000))

    assert.equal(replayed.length, 1)
    assert.equal(countUnreadAttention(replayed), 1)
  })

  test('a replayed event never resurrects a record the user already read', () => {
    const raised = recordAttention([], approval('node-1', 'perm-7', T0))
    const read = markAttentionRead(raised, { nodeId: 'node-1', at: T0 + 1_000 })
    const replayed = recordAttention(read, approval('node-1', 'perm-7', T0 + 90_000))

    assert.equal(replayed.length, 1)
    assert.equal(replayed[0].read, true)
    assert.equal(countUnreadAttention(replayed), 0)
  })

  test('distinct conditions on the same node stay separate records', () => {
    let state: AttentionState = recordAttention([], approval('node-1', 'perm-7', T0))
    state = recordAttention(state, { nodeId: 'node-1', kind: 'result', key: 'turn-a', at: T0 + 10 })
    state = recordAttention(state, { nodeId: 'node-1', kind: 'auth', key: 'auth', at: T0 + 20 })

    assert.equal(countUnreadAttention(state), 3)
    assert.deepEqual(unreadAttentionKinds(state), { approval: 1, auth: 1, result: 1, failure: 0, output: 0 })
  })
})

describe('coalescing high-volume output', () => {
  test('a burst inside the coalescing window leaves the state untouched', () => {
    const first = recordAttention([], { nodeId: 'term-1', kind: 'output', key: 'inc-1:0', at: T0 })
    let state = first
    for (let index = 1; index < 500; index += 1) {
      state = recordAttention(state, { nodeId: 'term-1', kind: 'output', key: 'inc-1:0', at: T0 + index })
    }

    assert.equal(state, first, 'a coalesced burst must not churn the state identity')
    assert.equal(state.length, 1)
    assert.equal(countUnreadAttention(state), 1)
  })

  test('output past the coalescing window folds into the same record rather than a new one', () => {
    const first = recordAttention([], { nodeId: 'term-1', kind: 'output', key: 'inc-1:0', at: T0 })
    const later = recordAttention(first, {
      nodeId: 'term-1',
      kind: 'output',
      key: 'inc-1:0',
      at: T0 + ATTENTION_COALESCE_WINDOW_MS + 1
    })

    assert.equal(later.length, 1)
    assert.equal(later[0].events, 2)
    assert.equal(later[0].updatedAt, T0 + ATTENTION_COALESCE_WINDOW_MS + 1)
  })

  test('output after the node was read raises again under the next burst key', () => {
    const raised = recordAttention([], { nodeId: 'term-1', kind: 'output', key: 'inc-1:0', at: T0 })
    const read = markAttentionRead(raised, { nodeId: 'term-1', at: T0 + 5 })
    const again = recordAttention(read, { nodeId: 'term-1', kind: 'output', key: 'inc-1:1', at: T0 + 10 })

    assert.equal(countUnreadAttention(again), 1)
    assert.equal(again.filter((item) => !item.read)[0].key, 'inc-1:1')
  })
})

describe('read and unread transitions', () => {
  test('reading a node clears only the records on that node', () => {
    let state: AttentionState = recordAttention([], approval('node-1', 'perm-7', T0))
    state = recordAttention(state, approval('node-2', 'perm-9', T0))

    const read = markAttentionRead(state, { nodeId: 'node-1', at: T0 + 1 })

    assert.equal(countUnreadAttention(read), 1)
    assert.deepEqual(unreadAttentionByNode(read), { 'node-2': 1 })
  })

  test('reading only the kinds the user reached leaves the rest unread', () => {
    let state: AttentionState = recordAttention([], approval('node-1', 'perm-7', T0))
    state = recordAttention(state, { nodeId: 'node-1', kind: 'result', key: 'turn-a', at: T0 })

    const read = markAttentionRead(state, { nodeId: 'node-1', at: T0 + 1, kinds: ['result'] })

    assert.deepEqual(unreadAttentionKinds(read), { approval: 1, auth: 0, result: 0, failure: 0, output: 0 })
  })

  test('reading a node with nothing unread returns the same state', () => {
    assert.deepEqual(markAttentionRead([], { nodeId: 'node-1', at: T0 }), [])

    const raised = recordAttention([], approval('node-1', 'perm-7', T0))
    const read = markAttentionRead(raised, { nodeId: 'node-1', at: T0 + 1 })
    assert.equal(markAttentionRead(read, { nodeId: 'node-1', at: T0 + 2 }), read)
  })

  test('mark unread restores the batch the last read cleared', () => {
    let state: AttentionState = recordAttention([], approval('node-1', 'perm-7', T0))
    state = markAttentionRead(state, { nodeId: 'node-1', at: T0 + 1 })
    state = recordAttention(state, { nodeId: 'node-1', kind: 'result', key: 'turn-a', at: T0 + 2 })
    state = markAttentionRead(state, { nodeId: 'node-1', at: T0 + 3 })

    const restored = markAttentionUnread(state, { nodeId: 'node-1', at: T0 + 4 })

    assert.equal(countUnreadAttention(restored), 1)
    assert.equal(restored.filter((item) => !item.read)[0].key, 'turn-a')
  })

  test('mark unread on a node that was never read changes nothing', () => {
    const state = recordAttention([], approval('node-1', 'perm-7', T0))
    assert.equal(markAttentionUnread(state, { nodeId: 'node-1', at: T0 + 1 }), state)
  })
})

describe('resolving and forgetting', () => {
  test('a condition that no longer holds drops its record', () => {
    let state: AttentionState = recordAttention([], { nodeId: 'node-1', kind: 'auth', key: 'auth', at: T0 })
    state = recordAttention(state, approval('node-1', 'perm-7', T0))

    const resolved = resolveAttention(state, { nodeId: 'node-1', kind: 'auth' })

    assert.equal(resolved.length, 1)
    assert.equal(resolved[0].kind, 'approval')
  })

  test('resolving one approval leaves another pending', () => {
    let state: AttentionState = recordAttention([], approval('node-1', 'perm-7', T0))
    state = recordAttention(state, approval('node-1', 'perm-8', T0))

    const resolved = resolveAttention(state, { nodeId: 'node-1', kind: 'approval', key: 'perm-7' })

    assert.deepEqual(resolved.map((item) => item.key), ['perm-8'])
  })

  test('closing a node forgets its records', () => {
    let state: AttentionState = recordAttention([], approval('node-1', 'perm-7', T0))
    state = recordAttention(state, approval('node-2', 'perm-9', T0))

    assert.deepEqual(forgetAttention(state, ['node-1']).map((item) => item.nodeId), ['node-2'])
  })

  test('restart recovery drops records whose node is gone and keeps the rest unread', () => {
    let state: AttentionState = recordAttention([], approval('node-1', 'perm-7', T0))
    state = recordAttention(state, approval('missing', 'perm-9', T0))

    const pruned = pruneAttention(state, ['node-1', 'node-3'])

    assert.equal(pruned.length, 1)
    assert.equal(pruned[0].nodeId, 'node-1')
    assert.equal(countUnreadAttention(pruned), 1)
  })
})

describe('bounds', () => {
  test('a node cannot hold more records than its cap, and read ones go first', () => {
    let state: AttentionState = []
    for (let index = 0; index < ATTENTION_NODE_ITEM_LIMIT; index += 1) {
      state = recordAttention(state, approval('node-1', `perm-${index}`, T0 + index))
    }
    state = markAttentionRead(state, { nodeId: 'node-1', at: T0 + 1_000 })
    state = recordAttention(state, approval('node-1', 'perm-fresh', T0 + 2_000))

    assert.equal(state.length, ATTENTION_NODE_ITEM_LIMIT)
    assert.equal(countUnreadAttention(state), 1)
    assert.ok(state.some((item) => item.key === 'perm-fresh'))
    assert.ok(!state.some((item) => item.key === 'perm-0'))
  })

  test('the workspace-wide record set stays bounded', () => {
    let state: AttentionState = []
    for (let index = 0; index < ATTENTION_ITEM_LIMIT + 50; index += 1) {
      state = recordAttention(state, approval(`node-${index}`, 'perm', T0 + index))
    }

    assert.equal(state.length, ATTENTION_ITEM_LIMIT)
  })
})

describe('cross-surface counts', () => {
  test('per-node, per-project and global counts come from the same records', () => {
    let state: AttentionState = recordAttention([], approval('node-1', 'perm-7', T0))
    state = recordAttention(state, { nodeId: 'node-1', kind: 'result', key: 'turn-a', at: T0 })
    state = recordAttention(state, approval('node-2', 'perm-9', T0))
    state = recordAttention(state, approval('node-3', 'perm-1', T0))

    const byNode = unreadAttentionByNode(state)
    const projectNodes = ['node-1', 'node-2']

    assert.deepEqual(byNode, { 'node-1': 2, 'node-2': 1, 'node-3': 1 })
    assert.equal(countUnreadAttention(state, projectNodes), 3)
    assert.equal(countUnreadAttention(state), 4)
    assert.equal(
      countUnreadAttention(state),
      Object.values(byNode).reduce((total, count) => total + count, 0)
    )
  })
})

describe('persistence validation', () => {
  test('accepts a saved record and rejects a malformed one', () => {
    const state = recordAttention([], approval('node-1', 'perm-7', T0))
    assert.equal(isAttentionItem(JSON.parse(JSON.stringify(state[0]))), true)
    assert.equal(isAttentionItem({ ...state[0], kind: 'nonsense' }), false)
    assert.equal(isAttentionItem({ ...state[0], read: 'yes' }), false)
    assert.equal(isAttentionItem(null), false)
  })
})

describe('what a node presents', () => {
  test('reading a node clears only the kinds that reading settles', () => {
    let state: AttentionState = recordAttention([], approval('node-1', 'perm-7', T0))
    state = recordAttention(state, { nodeId: 'node-1', kind: 'auth', key: 'auth', at: T0 })
    state = recordAttention(state, { nodeId: 'node-1', kind: 'result', key: 'turn-a', at: T0 })
    state = recordAttention(state, { nodeId: 'node-1', kind: 'failure', key: 'boom', at: T0 })

    const read = markAttentionRead(state, { nodeId: 'node-1', at: T0 + 1, kinds: READ_ON_VIEW_KINDS })

    assert.deepEqual(unreadAttentionKinds(read), { approval: 1, auth: 1, result: 0, failure: 0, output: 0 })
  })

  test('the most blocking unread record is the one the node shows', () => {
    let state: AttentionState = recordAttention([], { nodeId: 'node-1', kind: 'output', key: 'o', at: T0 })
    assert.equal(dominantUnreadKind(state, 'node-1'), 'output')

    state = recordAttention(state, { nodeId: 'node-1', kind: 'result', key: 'turn-a', at: T0 })
    assert.equal(dominantUnreadKind(state, 'node-1'), 'result')

    state = recordAttention(state, approval('node-1', 'perm-7', T0))
    assert.equal(dominantUnreadKind(state, 'node-1'), 'approval')

    assert.equal(dominantUnreadKind(state, 'node-2'), undefined)
    assert.equal(dominantUnreadKind(markAttentionRead(state, { nodeId: 'node-1', at: T0 + 1 }), 'node-1'), undefined)
  })
})

describe('the action reducer', () => {
  test('every action routes to the same transition its named function performs', () => {
    const raised = applyAttentionAction([], { type: 'raise', signal: { nodeId: 'node-1', kind: 'result', key: 'turn-a' } }, T0)
    assert.deepEqual(raised, recordAttention([], { nodeId: 'node-1', kind: 'result', key: 'turn-a', at: T0 }))

    const read = applyAttentionAction(raised, { type: 'read', nodeId: 'node-1' }, T0 + 1)
    assert.deepEqual(read, markAttentionRead(raised, { nodeId: 'node-1', at: T0 + 1 }))

    const unread = applyAttentionAction(read, { type: 'unread', nodeId: 'node-1' }, T0 + 2)
    assert.deepEqual(unread, markAttentionUnread(read, { nodeId: 'node-1', at: T0 + 2 }))

    const resolved = applyAttentionAction(unread, { type: 'resolve', nodeId: 'node-1', kind: 'result' }, T0 + 3)
    assert.deepEqual(resolved, [])
  })
})
