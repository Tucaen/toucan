import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DECISION_PROVIDER_PLUGIN_ID } from '../shared/decision-delegation'
import { claudeConfigRoot } from './claude-config'

/**
 * The availability probe behind decision delegation (issue #213): is the decision provider's
 * agent skill installed for Claude Code on this machine?
 *
 * It reads the plugin registry Claude Code maintains, `installed_plugins.json` under the config
 * root `claude-config.ts` resolves, and asks only whether the constant plugin id has an install
 * recorded. The install path beside each entry carries a version, so globbing the cache directory
 * would break on every bump; the id does not. Presence of the skill is the whole question - the
 * API key is the skill's own business and a missing one fails visibly in the transcript, where the
 * user can see it.
 *
 * No watcher: the probe is cheap and runs at the two moments the answer matters - session launch,
 * which is authoritative for what a session carries, and the picker opening, so a skill installed
 * mid-session is noticed by the surface that offers it.
 */
export function isDecisionProviderInstalled(
  homeDirectory: string,
  readFile = readFileSync,
  environment: NodeJS.ProcessEnv = process.env
): boolean {
  try {
    const registry = JSON.parse(
      readFile(join(claudeConfigRoot(homeDirectory, environment), 'plugins', 'installed_plugins.json'), 'utf8')
    ) as { plugins?: Record<string, unknown> }
    const installs = registry.plugins?.[DECISION_PROVIDER_PLUGIN_ID]
    return Array.isArray(installs) && installs.length > 0
  } catch {
    // An absent registry is the common case on a machine with no plugins, not an error worth
    // surfacing: it answers the question just as well as an empty one.
    return false
  }
}
