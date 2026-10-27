import { useCallback, useEffect, useId, useState } from 'react'
import { AGENT_PROVIDERS, type AgentProvider } from '../../shared/agent-provider'
import type {
  PluginContributions,
  PluginContributionsResult,
  PluginMcpServer,
  PluginSummary
} from '../../shared/plugins'
import { ModalDialog } from './ModalDialog'

/** What a plugin's part reaches; only a part that misses a provider is worth a badge. */
function ClaudeOnlyBadge({ providers }: { providers: AgentProvider[] }): JSX.Element | null {
  if (AGENT_PROVIDERS.every((provider) => providers.includes(provider))) return null
  return <span className="plugin-badge">Claude only</span>
}

function serverTarget(server: PluginMcpServer): string {
  return server.transport === 'stdio' ? [server.command, ...server.args].join(' ') : server.url
}

function Section({ title, empty, children }: { title: string; empty: boolean; children: JSX.Element[] }): JSX.Element {
  return (
    <section className="plugin-contributions-section">
      <span className="eyebrow-label">{title}</span>
      {empty ? <p className="plugin-note">None.</p> : <ul>{children}</ul>}
    </section>
  )
}

/**
 * What a plugin contributes, listed in full: a plugin runs code with the user's rights, so every
 * skill, script, MCP server command and hook is shown, with the parts only Claude receives marked.
 */
export function PluginContributionsView({ contributions }: { contributions: PluginContributions }): JSX.Element {
  const { skills, scripts, mcpServers, hooks, problems } = contributions
  return (
    <div className="plugin-contributions" role="region" aria-label={`Contributions of ${contributions.id}`}>
      <Section title="Skills" empty={skills.length === 0}>
        {skills.map((skill) => (
          <li key={skill.path}>
            <code>{skill.name}</code>
            {skill.description ? ` - ${skill.description}` : ''}
          </li>
        ))}
      </Section>
      <Section title="Scripts" empty={scripts.length === 0}>
        {scripts.map((script) => (
          <li key={script}>
            <code>{script}</code>
          </li>
        ))}
      </Section>
      <Section title="MCP servers" empty={mcpServers.length === 0}>
        {mcpServers.map((server) => (
          <li key={server.name}>
            <code>{server.name}</code> ({server.transport}): <code>{serverTarget(server)}</code>{' '}
            <ClaudeOnlyBadge providers={server.providers} />
          </li>
        ))}
      </Section>
      <Section title="Hooks" empty={hooks.length === 0}>
        {hooks.map((hook, index) => (
          <li key={index}>
            <code>{hook.event}</code>
            {hook.matcher ? ` on ${hook.matcher}` : ''} ({hook.type}
            {hook.command ? ': ' : ')'}
            {hook.command && (
              <>
                <code>{hook.command}</code>)
              </>
            )}{' '}
            <ClaudeOnlyBadge providers={hook.providers} />
          </li>
        ))}
      </Section>
      {problems.length > 0 && (
        <div role="alert" className="dialog-error">
          <p>Some parts could not be read:</p>
          <ul>
            {problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

type Review = { id: string; enabling: boolean; contributions: PluginContributionsResult | null }

/**
 * The plugins dialog (#56): add a plugin by choosing its folder, inspect what it contributes, and
 * enable or disable it for the active project. Enabling is the trust step - the review shows every
 * part that runs or steers an agent, and the plugin is enabled only from there. Changes reach
 * sessions created afterwards, and the dialog says so.
 */
export function PluginsDialog({
  project,
  onClose
}: {
  /** The project enablement applies to; absent while none is open, where plugins can only be added and inspected. */
  project?: { name: string; path: string }
  onClose(): void
}): JSX.Element {
  const ids = useId()
  const projectPath = project?.path
  const [plugins, setPlugins] = useState<PluginSummary[] | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [addError, setAddError] = useState<string | null>(null)
  const [added, setAdded] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [review, setReview] = useState<Review | null>(null)

  const reload = useCallback(async (): Promise<void> => {
    setPlugins(await window.pluginsApi.list(projectPath))
  }, [projectPath])

  useEffect(() => {
    let active = true
    window.pluginsApi
      .list(projectPath)
      .then((next) => {
        if (active) setPlugins(next)
      })
      .catch((reason: unknown) => {
        if (active) setFailure(String(reason))
      })
    return () => {
      active = false
    }
  }, [projectPath])

  /** Runs one change and then re-reads the list; an unexpected failure is shown, never swallowed. */
  const run = async (change: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setFailure(null)
    try {
      await change()
      await reload()
    } catch (reason) {
      setFailure(String(reason))
    } finally {
      setBusy(false)
    }
  }

  const add = (): Promise<void> =>
    run(async () => {
      setAdded(null)
      setAddError(null)
      const folder = await window.pluginsApi.pickFolder()
      if (folder === null) return
      const result = await window.pluginsApi.add(folder)
      if (result.ok) setAdded(result.plugin.id)
      else setAddError(result.error)
    })

  const inspect = (id: string, enabling: boolean): void => {
    setReview({ id, enabling, contributions: null })
    window.pluginsApi
      .contributions(id)
      .then((contributions) => setReview((current) => (current?.id === id ? { ...current, contributions } : current)))
      .catch((reason: unknown) =>
        setReview((current) =>
          current?.id === id ? { ...current, contributions: { ok: false, error: String(reason) } } : current
        )
      )
  }

  const change = (id: string, action: 'enable' | 'disable'): Promise<void> =>
    run(async () => {
      if (!projectPath) return
      const result = await window.pluginsApi[action](projectPath, id)
      if (!result.ok) {
        setFailure(result.error)
        return
      }
      setReview(null)
    })

  return (
    <ModalDialog labelledBy={`${ids}-title`} onClose={busy ? undefined : onClose}>
      <div className="dialog plugins-dialog">
        <strong id={`${ids}-title`}>Plugins</strong>
        <p>
          A plugin adds skills, scripts, MCP servers and hooks to agent sessions. Enable one only for the projects that
          need it.
        </p>
        <p className="plugin-note">
          Changes apply to sessions created afterwards; a running session keeps the plugins it started with.
        </p>
        <div className="dialog-actions plugin-add">
          <button type="button" disabled={busy} onClick={() => void add()}>
            Add plugin folder…
          </button>
        </div>
        {addError && (
          <p role="alert" className="dialog-error">
            Not added: {addError}
          </p>
        )}
        {!addError && added && <p role="status">Added “{added}”. Review what it contributes before enabling it.</p>}
        {!project && <p className="plugin-note">Open a project to enable plugins for it.</p>}
        {!plugins && !failure && <p role="status">Reading plugins…</p>}
        {plugins && plugins.length === 0 && <p className="plugin-note">No plugins added yet.</p>}
        {plugins && plugins.length > 0 && (
          <ul className="plugin-list" aria-label="Plugins">
            {plugins.map((plugin) => (
              <li key={plugin.id} className="plugin-row">
                <div className="plugin-row-head">
                  <strong>{plugin.id}</strong>
                  {plugin.manifest && <span className="plugin-note">{plugin.manifest.version}</span>}
                  {project && plugin.enabled && <span className="plugin-badge">Enabled for {project.name}</span>}
                </div>
                {plugin.manifest?.description && <p className="plugin-note">{plugin.manifest.description}</p>}
                <p className="plugin-note" title={plugin.root}>
                  {plugin.root}
                </p>
                {plugin.problem && (
                  <p role="alert" className="dialog-error">
                    {plugin.problem}
                  </p>
                )}
                <div className="dialog-actions">
                  <button
                    type="button"
                    aria-label={`Inspect ${plugin.id}`}
                    aria-expanded={review?.id === plugin.id}
                    disabled={busy || !!plugin.problem}
                    onClick={() => (review?.id === plugin.id ? setReview(null) : inspect(plugin.id, false))}
                  >
                    Inspect
                  </button>
                  {project &&
                    (plugin.enabled ? (
                      <button
                        type="button"
                        aria-label={`Disable ${plugin.id}`}
                        disabled={busy}
                        onClick={() => void change(plugin.id, 'disable')}
                      >
                        Disable
                      </button>
                    ) : (
                      <button
                        type="button"
                        aria-label={`Enable ${plugin.id}`}
                        disabled={busy || !!plugin.problem}
                        onClick={() => inspect(plugin.id, true)}
                      >
                        Enable…
                      </button>
                    ))}
                </div>
                {review?.id === plugin.id && (
                  <>
                    {!review.contributions && <p role="status">Reading what {plugin.id} contributes…</p>}
                    {review.contributions && !review.contributions.ok && (
                      <p role="alert" className="dialog-error">
                        {review.contributions.error}
                      </p>
                    )}
                    {review.contributions?.ok && (
                      <PluginContributionsView contributions={review.contributions.contributions} />
                    )}
                    {review.enabling && project && (
                      <div className="plugin-trust">
                        <p>
                          Enabling lets {plugin.id} run code with your rights in {project.name}: its scripts, MCP
                          servers and hooks. Enable it only if you trust what is listed above.
                        </p>
                        <div className="dialog-actions">
                          <button type="button" disabled={busy} onClick={() => setReview(null)}>
                            Cancel
                          </button>
                          <button
                            type="button"
                            className="primary"
                            disabled={busy || review.contributions?.ok !== true}
                            onClick={() => void change(plugin.id, 'enable')}
                          >
                            Enable for {project.name}
                          </button>
                        </div>
                      </div>
                    )}
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
        {failure && (
          <p role="alert" className="dialog-error">
            {failure}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" onClick={onClose} disabled={busy}>
            Close
          </button>
        </div>
      </div>
    </ModalDialog>
  )
}
