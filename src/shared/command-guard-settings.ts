/**
 * The user-wide "Command guard" preferences (ticket 03). They belong to the user, not to one canvas,
 * so they live in their own file rather than in the workspace snapshot. The guard itself (the hook
 * script and its default list) is `.agents/command-guard/`; this is only what the user may change.
 *
 * Changes reach sessions started afterwards. Like every session-launch policy the wording is
 * "requested, not confirmed" (CONTEXT.md): a session carries the hook, nothing verifies the agent
 * ran its commands through it.
 */

export interface CommandGuardPreferences {
  /** Off means no hook is registered on a session at all. */
  enabled: boolean
  /**
   * The user's pattern list, one regex per line; null follows the built-in list, so a default
   * improved by an app update reaches everyone who never edited it.
   */
  patterns: string | null
}

export const DEFAULT_COMMAND_GUARD_PREFERENCES: CommandGuardPreferences = { enabled: true, patterns: null }

/** What the dialog says about when a change takes effect. */
export const COMMAND_GUARD_SCOPE_NOTE =
  'Changes apply to sessions started from now on. A session that is already running keeps the guard it was started with.'

export const COMMAND_GUARD_REQUESTED_NOTE =
  'The guard is requested for each new Claude session, not confirmed: Toucan registers the hook, but cannot verify the agent runs its commands through it.'

export interface CommandGuardPatternError {
  /** 1-based, as the user sees it in the editor. */
  line: number
  message: string
}

export interface CommandGuardSettingsState {
  preferences: CommandGuardPreferences
  /** The built-in list, for "Reset to defaults" and as what `patterns: null` stands for. */
  defaults: string
}

export interface CommandGuardSaveRequest {
  enabled: boolean
  patterns: string
}

/** A save either lands or names every line that is not a regex; nothing invalid is stored. */
export type CommandGuardSaveResult =
  { ok: true; state: CommandGuardSettingsState } | { ok: false; errors: CommandGuardPatternError[] }

export interface CommandGuardSettingsApi {
  state(): Promise<CommandGuardSettingsState>
  save(request: CommandGuardSaveRequest): Promise<CommandGuardSaveResult>
}

const POSIX_CLASSES: Record<string, string> = {
  alnum: 'a-zA-Z0-9',
  alpha: 'a-zA-Z',
  blank: ' \\t',
  digit: '0-9',
  lower: 'a-z',
  space: '\\s',
  upper: 'A-Z',
  word: '\\w'
}

/**
 * Rewrites the POSIX bracket classes ERE allows (`[[:space:]]`) into their JavaScript spelling.
 * The same translation as `.agents/command-guard/guard.mjs`, which runs as a plain script and so
 * cannot import this; `tests/command-guard-settings.test.ts` keeps the two in agreement.
 * @internal exported for tests
 */
export function translateEre(source: string): string {
  return source.replace(/\[:(\w+):\]/g, (whole, name: string) => POSIX_CLASSES[name] ?? whole)
}

/** The line a list entry sits on is a pattern unless it is blank or a `#` comment. */
function isPatternLine(line: string): boolean {
  const trimmed = line.trim()
  return trimmed !== '' && !trimmed.startsWith('#')
}

/** Every pattern line that does not compile, with the line it is on and the engine's reason. */
export function validateCommandGuardPatterns(text: string): CommandGuardPatternError[] {
  const errors: CommandGuardPatternError[] = []
  text.split(/\r?\n/).forEach((raw, index) => {
    if (!isPatternLine(raw)) return
    try {
      new RegExp(translateEre(raw.trim()), 'i')
    } catch (error) {
      errors.push({ line: index + 1, message: error instanceof Error ? error.message : String(error) })
    }
  })
  return errors
}

/** Line endings and trailing blank lines are not a difference between two lists. */
export function normalizePatternText(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/\s+$/, '')
}

/** The list sessions get: the user's own, or the built-in one while they have not edited it. */
export function effectivePatternText(preferences: CommandGuardPreferences, defaults: string): string {
  return preferences.patterns ?? defaults
}

/** A saved list equal to the built-in one is stored as "follow the defaults". */
export function preferencesFromSave(request: CommandGuardSaveRequest, defaults: string): CommandGuardPreferences {
  const patterns = normalizePatternText(request.patterns) === normalizePatternText(defaults) ? null : request.patterns
  return { enabled: request.enabled, patterns }
}

export function parseCommandGuardPreferences(value: unknown): CommandGuardPreferences | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const { enabled, patterns } = value as Record<string, unknown>
  if (typeof enabled !== 'boolean') return null
  if (patterns !== null && typeof patterns !== 'string') return null
  return { enabled, patterns }
}
