import { useContext } from 'react'
import type { JSX } from 'react'
import type { AgentActivity } from '../../shared/agent'
import { shortenFilePath } from './file-operation'
import {
  clampSearchNavigation,
  searchNavigationFor,
  searchNavigationSummary,
  type SearchNavigation
} from './search-navigation'
import { WorkspaceRootsContext } from './workspace-root'

export function SearchNavigationSummary({ search }: { search: SearchNavigation }): JSX.Element {
  const external = search.kind === 'web-search' || search.kind === 'web-fetch'
  return (
    <>
      <span className="search-navigation-summary-label">{searchNavigationSummary(search)}</span>
      {search.kind === 'web-search' && search.results.length > 0 && (
        <span className="search-navigation-summary-detail">
          {search.results.length} {search.results.length === 1 ? 'result' : 'results'}
        </span>
      )}
      {external && <span className="external-source-badge">External source</span>}
    </>
  )
}

export function SearchNavigationBody({ search }: { search: SearchNavigation }): JSX.Element {
  const roots = useContext(WorkspaceRootsContext)
  if (search.kind === 'web-fetch') {
    return (
      <div className="web-fetch-result">
        <small>External content from {search.host}</small>
        <code>{search.url}</code>
        {search.content && <pre>{search.content}</pre>}
      </div>
    )
  }
  if (search.kind === 'web-search') {
    return search.results.length === 0 ? (
      <p className="search-zero-result">No web results found</p>
    ) : (
      <div className="web-results">
        {search.results.map((result) => (
          <div className="web-result" key={result.url}>
            <strong>{result.title}</strong>
            <small>{result.host}</small>
            <code>{result.url}</code>
          </div>
        ))}
      </div>
    )
  }
  if (search.kind === 'glob') {
    return search.paths.length === 0 ? (
      <p className="search-zero-result">No files found</p>
    ) : (
      <div className="search-path-results">
        {search.paths.map((path) => (
          <code title={path} key={path}>
            {shortenFilePath(path, roots)}
          </code>
        ))}
      </div>
    )
  }
  if (search.matchCount === 0) return <p className="search-zero-result">No matches found</p>
  return (
    <div className="search-result-groups">
      {search.groups.map((group) => (
        <section className="search-result-group" key={group.path}>
          <code className="search-result-path" title={group.path}>
            {shortenFilePath(group.path, roots)}
          </code>
          <div className="search-result-lines">
            {group.matches.map((match, index) => (
              <div className="search-result-line" key={`${match.line ?? 'result'}-${index}`}>
                <span className="tool-line-number" aria-hidden="true">
                  {match.line}
                </span>
                <span>{match.text}</span>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}

export function searchNavigationCard(
  activity: AgentActivity,
  lineBudget: number | null
): { search: SearchNavigation; hiddenLines: number } | null {
  const search = searchNavigationFor(activity)
  if (!search) return null
  return clampSearchNavigation(search, lineBudget)
}
