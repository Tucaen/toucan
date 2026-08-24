import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  firstMateActiveProvider,
  firstMateCaptainState,
  firstMateClosedDecisionIds,
  firstMateWithCaptainState,
  type FirstMateWorkspaceState
} from '../src/shared/firstmate'

test('defaults a new FirstMate dock to the Codex captain', () => {
  assert.equal(firstMateActiveProvider({}), 'codex')
  assert.deepEqual(firstMateCaptainState({}, 'codex'), {})
})

test('closed decisions are selected only for their captain conversation', () => {
  const state: FirstMateWorkspaceState = {
    captains: {
      codex: {
        conversationId: 'new-session',
        closedDecisionConversationId: 'old-session',
        closedDecisionIds: ['alpha:storage']
      }
    }
  }
  assert.deepEqual(firstMateClosedDecisionIds(state, 'codex', 'old-session'), ['alpha:storage'])
  assert.deepEqual(firstMateClosedDecisionIds(state, 'codex', 'new-session'), [])
  assert.deepEqual(firstMateClosedDecisionIds(state, 'claude', 'old-session'), [])
})

test('updates one captain without changing the other provider or dock presentation', () => {
  const state: FirstMateWorkspaceState = {
    activeProvider: 'claude',
    captains: {
      codex: { conversationId: 'codex-session', modelId: 'gpt-5' },
      claude: { conversationId: 'claude-session', modelId: 'opus' }
    },
    worklogCollapsed: false,
    panelWidth: 510
  }

  const updated = firstMateWithCaptainState(state, 'claude', {
    conversationId: 'new-claude-session',
    permissionMode: 'bypassPermissions',
    effortId: 'max'
  })

  assert.deepEqual(updated, {
    ...state,
    captains: {
      codex: state.captains?.codex,
      claude: {
        conversationId: 'new-claude-session',
        modelId: 'opus',
        permissionMode: 'bypassPermissions',
        effortId: 'max'
      }
    }
  })
})
