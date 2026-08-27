import type { AgentRateLimitStatus, AgentRateLimitWindow } from '../shared/agent'

/**
 * Claude publishes plan usage nowhere on disk - its transcripts carry a `rateLimits` field that is
 * always null - and the ACP adapter only forwards a usage report after an assistant turn has
 * produced tokens. The Claude Agent SDK's usage control request is the only source that answers
 * before a conversation exists, which is what makes the header readable at startup.
 *
 * The request is a control-protocol round trip, not a model call: the prompt stream deliberately
 * never yields, so the CLI boots, answers, and exits without starting a turn or spending tokens.
 */

/**
 * The SDK is ESM-only while this process is bundled to CommonJS, and esbuild rewrites a literal
 * `import()` in CommonJS output into `require()`, which cannot load an ESM package. Constructing the
 * import through `Function` keeps it opaque to the bundler so it survives as a real dynamic import.
 */
const importEsm = new Function('specifier', 'return import(specifier)') as (
  specifier: string
) => Promise<unknown>

/** Booting the CLI dominates this call, so the bound is generous relative to a local round trip. */
const READ_TIMEOUT_MS = 30_000

/** The experimental method name the SDK exposes for `/usage`; absent on versions that predate it. */
const USAGE_METHOD = 'usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET'

interface SdkUsageWindow {
  utilization?: unknown
  resets_at?: unknown
}

interface SdkUsageResponse {
  rate_limits_available?: unknown
  rate_limits?: {
    five_hour?: SdkUsageWindow | null
    seven_day?: SdkUsageWindow | null
  } | null
}

interface SdkQuery extends AsyncGenerator<unknown, void> {
  [USAGE_METHOD]?: () => Promise<SdkUsageResponse>
}

function toWindow(payload: SdkUsageWindow | null | undefined): AgentRateLimitWindow | undefined {
  if (!payload || typeof payload.utilization !== 'number') return undefined
  // Unlike Codex's epoch seconds, the SDK reports this as an ISO 8601 string.
  const resetsAt = typeof payload.resets_at === 'string' ? Date.parse(payload.resets_at) : Number.NaN
  return {
    usedPercent: payload.utilization,
    ...(Number.isFinite(resetsAt) ? { resetsAt } : {})
  }
}

/** Exported for tests: maps one SDK usage response onto the shape the renderer displays. */
export function claudeRateLimitsFromUsage(response: SdkUsageResponse | null | undefined): AgentRateLimitStatus | null {
  // Plan limits do not apply to API-key, Bedrock, or Vertex sessions, which report no windows.
  if (!response || response.rate_limits_available === false) return null
  const fiveHour = toWindow(response.rate_limits?.five_hour)
  const weekly = toWindow(response.rate_limits?.seven_day)
  if (!fiveHour && !weekly) return null
  return {
    ...(fiveHour ? { fiveHour } : {}),
    ...(weekly ? { weekly } : {})
  }
}

export interface ClaudeUsageReaderOptions {
  /** Where the throwaway session is rooted; only affects which settings the CLI loads. */
  cwd: string
  /** Injected in tests so no CLI is spawned. */
  requestUsage?(cwd: string): Promise<SdkUsageResponse | null>
}

export interface ClaudeUsageReader {
  read(): Promise<AgentRateLimitStatus | null>
}

async function requestUsageViaSdk(cwd: string): Promise<SdkUsageResponse | null> {
  const sdk = await importEsm('@anthropic-ai/claude-agent-sdk') as {
    query?: (params: { prompt: AsyncIterable<never>; options?: { cwd?: string } }) => SdkQuery
  }
  if (typeof sdk.query !== 'function') return null

  // Never yields: the CLI reaches an idle, answerable state without a turn ever starting.
  const idlePrompt = (async function* (): AsyncGenerator<never, void> {
    await new Promise<never>(() => {})
  })()

  const query = sdk.query({ prompt: idlePrompt, options: { cwd } })
  const readUsage = query[USAGE_METHOD]
  if (typeof readUsage !== 'function') {
    await query.return?.(undefined).catch(() => undefined)
    return null
  }
  try {
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Claude usage request timed out')), READ_TIMEOUT_MS)
    })
    try {
      return await Promise.race([readUsage.call(query), timeout])
    } finally {
      if (timer) clearTimeout(timer)
    }
  } finally {
    // Ends the idle prompt stream so the CLI shuts down instead of lingering until app exit.
    await query.return?.(undefined).catch(() => undefined)
  }
}

export function createClaudeUsageReader(options: ClaudeUsageReaderOptions): ClaudeUsageReader {
  const requestUsage = options.requestUsage ?? requestUsageViaSdk
  return {
    async read(): Promise<AgentRateLimitStatus | null> {
      try {
        return claudeRateLimitsFromUsage(await requestUsage(options.cwd))
      } catch {
        // An unauthenticated, missing, or changed CLI must leave the header blank, not crash it.
        return null
      }
    }
  }
}
