import { useState } from 'react'
import { hostBlockedByPageScheme, type HostDirectory, type SavedHost } from './hosts'
import { effectiveHostStatus, hostStatusLabel, type HostStatuses } from './host-status'

/**
 * The saved hosts: which one is being driven, which ones are up, and the four things that can be
 * done to the list. Reachable from the chat list because switching PCs is a navigation, not a
 * setting - the reader has just found the chat they wanted is on the other machine.
 *
 * Every host is shown with its own state, which is the whole point of this screen: a PC that is off
 * says so *here*, next to the one that is answering, so the reader can tell "Toucan is not running
 * on the work PC" from "nothing is running anywhere". A host that stopped accepting its token is a
 * third thing again, and it is per host - pasting a new token for one never touches the other.
 */
export default function HostsScreen({
  directory,
  statuses,
  onBack,
  onSelect,
  onRename,
  onRemove,
  onAddHost
}: {
  directory: HostDirectory
  statuses: HostStatuses
  onBack(): void
  onSelect(id: string): void
  onRename(id: string, name: string): void
  onRemove(id: string): void
  onAddHost(): void
}): JSX.Element {
  const [renaming, setRenaming] = useState<string | null>(null)
  // Removal is one tap away from losing a pairing token, so it is confirmed in place rather than
  // with a dialog a thumb can dismiss by accident.
  const [confirming, setConfirming] = useState<string | null>(null)

  return (
    <main className="screen">
      <header className="chat-head">
        <button type="button" className="back" onClick={onBack} aria-label="Back to chats">
          ‹
        </button>
        <div className="chat-head-copy">
          <h1>Hosts</h1>
        </div>
      </header>

      <ul className="host-list">
        {directory.hosts.map((host) => {
          const status = effectiveHostStatus(host, statuses)
          const selected = host.id === directory.selectedId
          const blocked = hostBlockedByPageScheme(host.origin, window.location.protocol)
          return (
            <li key={host.id} className="host-row" data-selected={selected || undefined}>
              {renaming === host.id ? (
                <RenameHost
                  host={host}
                  onDone={(name) => {
                    if (name !== null) onRename(host.id, name)
                    setRenaming(null)
                  }}
                />
              ) : (
                <>
                  <button
                    type="button"
                    className="host"
                    aria-current={selected || undefined}
                    onClick={() => onSelect(host.id)}
                  >
                    <span className="host-dot" data-reachability={status.reachability} aria-hidden="true" />
                    <span className="host-copy">
                      <strong>{host.name}</strong>
                      <small>{host.origin}</small>
                      {/* The colour is a glance; the words are the answer. */}
                      <small className="host-state" data-reachability={status.reachability}>
                        {hostStatusLabel(status)}
                        {selected && ' · driving'}
                      </small>
                      {status.reachability === 'offline' && status.message && (
                        <small className="host-problem">{status.message}</small>
                      )}
                      {blocked && <small className="host-problem">{blocked}</small>}
                    </span>
                  </button>
                  <div className="host-actions">
                    <button type="button" onClick={() => setRenaming(host.id)}>
                      Rename
                    </button>
                    {confirming === host.id ? (
                      <>
                        <button type="button" className="host-remove" onClick={() => onRemove(host.id)}>
                          Remove
                        </button>
                        <button type="button" onClick={() => setConfirming(null)}>
                          Keep
                        </button>
                      </>
                    ) : (
                      <button type="button" onClick={() => setConfirming(host.id)}>
                        Forget
                      </button>
                    )}
                  </div>
                </>
              )}
            </li>
          )
        })}
      </ul>

      <button type="button" className="new-chat" onClick={onAddHost}>
        Add host
      </button>
      <p className="hint">
        Each host is a Toucan running on its own PC, with its own pairing token. Switching hosts closes the connections
        to the previous one.
      </p>
    </main>
  )
}

function RenameHost({ host, onDone }: { host: SavedHost; onDone(name: string | null): void }): JSX.Element {
  const [name, setName] = useState(host.name)
  return (
    <form
      className="host-rename"
      onSubmit={(event) => {
        event.preventDefault()
        onDone(name)
      }}
    >
      <label>
        <span>Name</span>
        <input
          autoFocus
          value={name}
          aria-label={`Name for ${host.origin}`}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <button type="submit">Save</button>
      <button type="button" onClick={() => onDone(null)}>
        Cancel
      </button>
    </form>
  )
}
