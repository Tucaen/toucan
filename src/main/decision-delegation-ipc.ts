import { DECISION_DELEGATION_CHANNELS } from '../shared/ipc-channels'
import type { IpcRegistrar } from './ipc-registrar'

/**
 * The renderer's only route to the decision-provider availability probe (issue #213). One channel,
 * asked when the decisions picker opens, because that is when a stale answer would be visible:
 * a skill installed mid-session should be offerable without restarting Toucan. The launch-time
 * probe in `acp-session-manager.ts` is the authoritative one - this only decides whether the
 * picker's "On" option is offered.
 */
export function registerDecisionDelegationIpc(ipc: IpcRegistrar, isInstalled: () => boolean): void {
  ipc.handle(DECISION_DELEGATION_CHANNELS.availability, (): boolean => isInstalled())
}
