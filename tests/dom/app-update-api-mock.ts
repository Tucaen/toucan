import { vi } from 'vitest'
import type { AppUpdateApi, AppUpdateSnapshot } from '../../src/shared/app-update'

/**
 * The update bridge as an App-level render needs it: a host that has answered, is on the version
 * it says it is, and never pushes anything. Screens that are not about updating want the header to
 * render and then be quiet.
 */
export function createMockAppUpdateApi(currentVersion = '0.2.0'): AppUpdateApi {
  const idle: AppUpdateSnapshot = { currentVersion, status: { phase: 'idle' } }
  return {
    state: vi.fn(async () => idle),
    check: vi.fn(async () => idle),
    restart: vi.fn(async () => false),
    onChange: () => () => undefined
  }
}
