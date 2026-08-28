import { createContext } from 'react'
import type { ProviderRateLimits } from '../../shared/agent'

/**
 * Account usage is a property of the provider, not of a session: one poll in `App` answers for
 * every node of that provider. Nodes read their own provider's slot from here rather than each
 * one polling `usageApi.rateLimits()`, which would multiply a request that boots a CLI process
 * (see `src/main/provider-usage.ts`) by the number of open chats.
 */
export const ProviderRateLimitsContext = createContext<ProviderRateLimits>({})
