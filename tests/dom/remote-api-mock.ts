import { vi } from 'vitest'
import type { RemoteAccessState } from '../../src/shared/remote-access'
import type { RemoteApi } from '../../src/shared/remote-api'

/**
 * The remote-access bridge as an App-level render needs it when the test is about something else:
 * a host that has answered, is not listening, and never asks the canvas to do anything.
 *
 * It exists so that a new member on `RemoteApi` is one edit rather than one per screen test - the
 * hook subscribes to every push channel on mount, so a missing member is a crash in tests with no
 * interest in remote access at all. `tests/remote-access.dom.test.tsx` builds its own instead,
 * because there the bridge is the subject.
 */
export function createMockRemoteApi(): RemoteApi {
  const idle: RemoteAccessState = {
    settings: { enabled: false, port: 7391 },
    listening: false,
    token: 'token',
    tokenUpdatedAt: 0,
    addresses: []
  }
  return {
    state: vi.fn(async () => idle),
    applySettings: vi.fn(async () => idle),
    regenerateToken: vi.fn(async () => idle),
    publishWorkspace: vi.fn(),
    onStateChange: () => () => undefined,
    onSpawnChat: () => () => undefined,
    completeSpawn: vi.fn(),
    onMarkChatRead: () => () => undefined
  }
}
