/**
 * The single definition of the environment variable names ADE sets when it hosts FirstMate, and the
 * construction of the process and tmux environments that carry them. The ADE-owned `ADE_FIRSTMATE_*`
 * names in particular are authored once here and interpolated everywhere else — the launch process
 * environment, the tmux `set-environment` blocks inside the inline WSL scripts, and the validation
 * dispatch environment all derive their names from these constants rather than restating them.
 */

/** Owned by ADE: the pinned runtime record and validator selection a task-scoped continuation reads. */
export const ADE_FIRSTMATE_RUNTIME_CONFIG = 'ADE_FIRSTMATE_RUNTIME_CONFIG'
export const ADE_FIRSTMATE_VALIDATOR_AGENT = 'ADE_FIRSTMATE_VALIDATOR_AGENT'
export const ADE_FIRSTMATE_VALIDATOR_MODEL = 'ADE_FIRSTMATE_VALIDATOR_MODEL'

/** Owned by FirstMate and its managed distro, but set consistently by ADE from these names. */
export const FM_HOME = 'FM_HOME'
export const FM_BACKEND = 'FM_BACKEND'
export const NM_HOME = 'NM_HOME'
export const CODEX_HOME = 'CODEX_HOME'
export const CLAUDE_CONFIG_DIR = 'CLAUDE_CONFIG_DIR'
export const FM_SUPERVISOR_BACKEND = 'FM_SUPERVISOR_BACKEND'
export const FM_SUPERVISOR_TARGET = 'FM_SUPERVISOR_TARGET'

export interface FirstMateSupervisionEnvironmentSpec {
  /** ADE's private FirstMate home in the WSL host. */
  homePath: string
  /** The runtime record this environment points a reader at: the global config or a task-scoped one. */
  runtimeConfigPath: string
  validatorAgent: string
  validatorModel: string
  /** Task-scoped no-mistakes home; defaults to `${homePath}/no-mistakes` when omitted. */
  nmHome?: string
  /**
   * `FM_SUPERVISOR_*` announces the app-native supervisor to a fresh captain launch and its tmux
   * session. A task validation dispatch inherits an already-supervised session and omits them.
   */
  announceSupervisor?: boolean
}

/**
 * The ordered supervision variables ADE sets, as `[name, value]` pairs. One definition backs the
 * launch process environment, the tmux session environment, and the validation dispatch environment;
 * each caller formats these pairs for its transport.
 */
export function firstMateSupervisionEnvironment(
  spec: FirstMateSupervisionEnvironmentSpec
): Array<[string, string]> {
  const pairs: Array<[string, string]> = [
    [FM_HOME, spec.homePath],
    [NM_HOME, spec.nmHome ?? `${spec.homePath}/no-mistakes`],
    [CODEX_HOME, `${spec.homePath}/codex`],
    [CLAUDE_CONFIG_DIR, `${spec.homePath}/claude`]
  ]
  if (spec.announceSupervisor !== false) {
    pairs.push([FM_SUPERVISOR_BACKEND, 'ade'], [FM_SUPERVISOR_TARGET, 'ade-firstmate-acp'])
  }
  pairs.push(
    [ADE_FIRSTMATE_RUNTIME_CONFIG, spec.runtimeConfigPath],
    [ADE_FIRSTMATE_VALIDATOR_AGENT, spec.validatorAgent],
    [ADE_FIRSTMATE_VALIDATOR_MODEL, spec.validatorModel]
  )
  return pairs
}

/** Formats supervision pairs as `NAME=value` process-environment arguments. */
export function firstMateProcessEnvironment(spec: FirstMateSupervisionEnvironmentSpec): string[] {
  return firstMateSupervisionEnvironment(spec).map(([name, value]) => `${name}=${value}`)
}
