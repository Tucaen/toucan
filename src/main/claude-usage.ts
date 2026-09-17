import { existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { AgentModelRateLimitWindow, AgentRateLimitStatus, AgentRateLimitWindow } from '../shared/agent'
import { resolveUnpackedExecutable } from './agent-process'

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
const importEsm = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<unknown>

const SDK_PACKAGE = '@anthropic-ai/claude-agent-sdk'

/**
 * Code built through `Function` has no module referrer, so Node resolves a bare specifier against
 * the process cwd: the repo root under `npm run dev`, but whatever directory the installed app was
 * launched from - where no `node_modules` exists and the import fails. This module is CommonJS, so
 * `require.resolve` walks up from `out/main/index.js` and lands in `app.asar/node_modules`; the
 * package's `default` export condition names the ESM entry without executing it.
 */
export function resolveClaudeSdkSpecifier(): string {
  return pathToFileURL(require.resolve(SDK_PACKAGE)).href
}

export interface ClaudeExecutableLookup {
  /** The directory holding the SDK's own module; the platform package is looked up from there. */
  sdkDir: string
  platform: NodeJS.Platform
  arch: string
  /** Resolves a package subpath the way `require.resolve` does from `fromDir`; throws when absent. */
  resolve(specifier: string, fromDir: string): string
  exists(path: string): boolean
}

/** The platform packages the SDK itself tries, in its order (glibc before musl, since Toucan cannot tell). */
function claudePlatformPackages(platform: NodeJS.Platform, arch: string): string[] {
  const base = `${SDK_PACKAGE}-${platform}-${arch}`
  return platform === 'linux' ? [base, `${base}-musl`] : [base]
}

/**
 * The SDK finds `claude.exe` relative to its own module - the copy nested under its own
 * `node_modules` first, the hoisted one otherwise - and hands that path straight to `spawn`. In the
 * installed app that path is inside `app.asar`, and Electron does not remap `child_process` the way
 * it remaps `fs`, so the spawn fails with the SDK's misleading libc message (#157). The ACP adapter
 * never hit this because it runs in a child whose preload rewrites every spawn; the usage reader
 * runs the SDK in the main process, so it must perform the same rewrite up front and pass the result
 * as `pathToClaudeCodeExecutable`. Returns undefined when the SDK is installed without a platform
 * package, in which case the SDK's own lookup (and its own error) is the right outcome.
 */
export function resolveClaudeExecutable(
  lookup: ClaudeExecutableLookup = {
    sdkDir: dirname(require.resolve(SDK_PACKAGE)),
    platform: process.platform,
    arch: process.arch,
    resolve: (specifier, fromDir) => require.resolve(specifier, { paths: [fromDir] }),
    exists: existsSync
  }
): string | undefined {
  const binary = lookup.platform === 'win32' ? 'claude.exe' : 'claude'
  for (const pkg of claudePlatformPackages(lookup.platform, lookup.arch)) {
    let resolved: string
    try {
      resolved = lookup.resolve(`${pkg}/${binary}`, lookup.sdkDir)
    } catch {
      continue
    }
    const executable = resolveUnpackedExecutable(resolved, lookup.exists)
    if (lookup.exists(executable)) return executable
  }
  return undefined
}

/** Booting the CLI dominates this call, so the bound is generous relative to a local round trip. */
const READ_TIMEOUT_MS = 30_000

/** The experimental method name the SDK exposes for `/usage`; absent on versions that predate it. */
const USAGE_METHOD = 'usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET'

interface SdkUsageWindow {
  utilization?: unknown
  resets_at?: unknown
}

interface SdkModelScopedWindow extends SdkUsageWindow {
  display_name?: unknown
}

interface SdkUsageResponse {
  rate_limits_available?: unknown
  rate_limits?: {
    five_hour?: SdkUsageWindow | null
    seven_day?: SdkUsageWindow | null
    /** Per-model weekly windows, e.g. the Fable allowance; only present when the server emits them. */
    model_scoped?: SdkModelScopedWindow[] | null
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

/**
 * `model_scoped` buckets are weekly, like `seven_day`; the SDK states the scope in its docs rather
 * than in the payload, so the span is attached here where that knowledge lives.
 */
const MODEL_WINDOW_MINUTES = 7 * 24 * 60

function toModelWindows(payload: SdkModelScopedWindow[] | null | undefined): AgentModelRateLimitWindow[] {
  if (!Array.isArray(payload)) return []
  const models: AgentModelRateLimitWindow[] = []
  for (const entry of payload) {
    const window = toWindow(entry)
    // The server names the bucket ("Fable"); an unnamed one has nothing a reader could attribute it to.
    if (!window || typeof entry.display_name !== 'string' || entry.display_name.trim() === '') continue
    models.push({ label: entry.display_name.trim(), windowMinutes: MODEL_WINDOW_MINUTES, ...window })
  }
  return models
}

/** Exported for tests: maps one SDK usage response onto the shape the renderer displays. */
export function claudeRateLimitsFromUsage(response: SdkUsageResponse | null | undefined): AgentRateLimitStatus | null {
  // Plan limits do not apply to API-key, Bedrock, or Vertex sessions, which report no windows.
  if (!response || response.rate_limits_available === false) return null
  const fiveHour = toWindow(response.rate_limits?.five_hour)
  const weekly = toWindow(response.rate_limits?.seven_day)
  const models = toModelWindows(response.rate_limits?.model_scoped)
  if (!fiveHour && !weekly && models.length === 0) return null
  return {
    ...(fiveHour ? { fiveHour } : {}),
    ...(weekly ? { weekly } : {}),
    ...(models.length > 0 ? { models } : {})
  }
}

export interface ClaudeUsageReaderOptions {
  /** Where the throwaway session is rooted; only affects which settings the CLI loads. */
  cwd: string
  /** Injected in tests so no CLI is spawned. */
  requestUsage?(cwd: string): Promise<SdkUsageResponse | null>
  /** Receives the reason a read failed, so a blank header is never silent. */
  log(message: string): void
}

export interface ClaudeUsageReader {
  read(): Promise<AgentRateLimitStatus | null>
}

interface SdkQueryOptions {
  cwd?: string
  pathToClaudeCodeExecutable?: string
}

interface ClaudeSdkModule {
  query?: (params: { prompt: AsyncIterable<never>; options?: SdkQueryOptions }) => SdkQuery
}

export interface SdkRequestDependencies {
  loadSdk(): Promise<ClaudeSdkModule>
  locateExecutable(): string | undefined
}

const liveDependencies: SdkRequestDependencies = {
  loadSdk: () => importEsm(resolveClaudeSdkSpecifier()) as Promise<ClaudeSdkModule>,
  locateExecutable: () => resolveClaudeExecutable()
}

/** Exported for tests, which substitute the SDK so no CLI is spawned. */
export async function requestUsageViaSdk(
  cwd: string,
  dependencies: SdkRequestDependencies = liveDependencies
): Promise<SdkUsageResponse | null> {
  const sdk = await dependencies.loadSdk()
  if (typeof sdk.query !== 'function') return null
  const executable = dependencies.locateExecutable()

  // Never yields: the CLI reaches an idle, answerable state without a turn ever starting.
  const idlePrompt = (async function* (): AsyncGenerator<never, void> {
    await new Promise<never>(() => {})
  })()

  const query = sdk.query({
    prompt: idlePrompt,
    options: { cwd, ...(executable ? { pathToClaudeCodeExecutable: executable } : {}) }
  })
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
      } catch (error) {
        // An unauthenticated, missing, or changed CLI must leave the header blank, not crash it -
        // but a blank header with no trace is how a resolution bug shipped unnoticed (#157).
        options.log(`usage read failed: ${error instanceof Error ? error.message : String(error)}`)
        return null
      }
    }
  }
}
