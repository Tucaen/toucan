import { useEffect, useRef, useState } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { Terminal } from '@xterm/xterm'
import { createCanvasTerminal, TERMINAL_ACCENT } from './canvas-terminal'
import type { TerminalCanvasNode } from './canvas-workspace'
import { READ_ON_VIEW_KINDS } from '../../shared/attention'
import NodeBorderResizer from './NodeBorderResizer'
import NodeFitAction from './NodeFitAction'
import SessionKindIcon from './SessionKindIcon'
import UnreadToggle from './UnreadToggle'
import { CanvasTerminalLiveness } from './TerminalLivenessPresentation'
import WorktreeBadge from './WorktreeBadge'

export default function TerminalNode({ id, data, selected }: NodeProps<TerminalCanvasNode>): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const exitedRef = useRef(false)
  const incarnationRef = useRef<string | null>(null)
  const unreadHoldRef = useRef(false)
  // Read at call time by the PTY effect, which must not re-run - and so kill and respawn the shell
  // - just because the node was renamed.
  const labelRef = useRef(data.label)
  labelRef.current = data.label
  const [hasSelection, setHasSelection] = useState(false)
  const [scrollbackState, setScrollbackState] = useState<'loading' | 'available' | 'missing'>('loading')
  const hasRestoredScrollback = scrollbackState === 'available'

  const markRead = (): void => {
    data.onAttention?.({ type: 'read', nodeId: id, kinds: READ_ON_VIEW_KINDS })
  }

  const acknowledgeActivity = (): void => {
    if (!unreadHoldRef.current) markRead()
    if (!data.dormant && !exitedRef.current) data.onStatusChange(id, 'idle')
  }

  const copySelection = (): void => {
    const selection = terminalRef.current?.getSelection()
    if (selection) window.shellApi.copyText(selection)
  }

  useEffect(() => {
    if (!selected) unreadHoldRef.current = false
    if (selected && !data.dormant) acknowledgeActivity()
    // `acknowledgeActivity` is rebuilt every render, so listing it would fire this on every render
    // rather than on a selection change - which is the whole trigger. Selection and dormancy are
    // the only inputs the effect reacts to; everything else it touches, it reads at call time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.dormant, selected])

  useEffect(() => {
    if (!data.dormant || !hostRef.current) return

    let active = true
    setScrollbackState('loading')
    const { terminal, dispose } = createCanvasTerminal(hostRef.current, { interactive: false })
    terminalRef.current = terminal

    const historyRequest = window.terminalApi.scrollback?.(data.sessionId)
    if (historyRequest !== undefined)
      void historyRequest
        .then((snapshot) => {
          if (!active) return
          if (!snapshot || snapshot.sessionId !== data.sessionId) {
            setScrollbackState('missing')
            return
          }
          terminal.write(snapshot.data)
          if (snapshot.truncated || snapshot.incomplete) {
            terminal.write('\r\n\x1b[33m[Earlier output was truncated or incomplete.]\x1b[0m\r\n')
          }
          setScrollbackState('available')
        })
        .catch(() => {
          if (active) setScrollbackState('missing')
        })
    else setScrollbackState('missing')

    return () => {
      active = false
      terminalRef.current = null
      dispose()
    }
  }, [data.dormant, data.sessionId])

  useEffect(() => {
    if (data.dormant || !hostRef.current) return

    let active = true
    let started = false
    const attachmentId = crypto.randomUUID()
    const { terminal, fit, dispose } = createCanvasTerminal(hostRef.current, {
      interactive: true,
      onFit: (fitted) => {
        if (started && incarnationRef.current)
          window.terminalApi.resize(data.sessionId, incarnationRef.current, fitted.cols, fitted.rows)
      }
    })
    terminalRef.current = terminal

    exitedRef.current = false
    const removeDataListener = window.terminalApi.onData(data.sessionId, attachmentId, (output) => {
      incarnationRef.current ??= output.incarnationId
      terminal.write(output.data)
    })
    const removeExitListener = window.terminalApi.onExit(data.sessionId, attachmentId, (result) => {
      incarnationRef.current ??= result.incarnationId
      exitedRef.current = true
      data.onTerminalLiveness?.(id, 'exited')
      data.onStatusChange(id, 'exited')
      // A shell that died on an error is worth coming back to; a clean exit is not.
      if (result.exitCode !== 0) {
        data.onAttention?.({
          type: 'raise',
          signal: {
            nodeId: id,
            kind: 'failure',
            key: `exit:${result.incarnationId}:${result.exitCode}`,
            sourceId: data.sessionId,
            summary: `${labelRef.current} exited with code ${result.exitCode}`
          }
        })
      }
      terminal.write(`\r\n\x1b[90mSession exited with code ${result.exitCode}.\x1b[0m\r\n`)
    })
    const inputSubscription = terminal.onData((input) => {
      acknowledgeActivity()
      if (incarnationRef.current) window.terminalApi.write(data.sessionId, incarnationRef.current, input)
    })
    const selectionSubscription = terminal.onSelectionChange(() => setHasSelection(terminal.hasSelection()))
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown') return true

      const copyShortcut =
        (event.ctrlKey && event.shiftKey && event.code === 'KeyC') || (event.ctrlKey && event.code === 'Insert')
      if (copyShortcut) {
        if (terminal.hasSelection()) window.shellApi.copyText(terminal.getSelection())
        return false
      }

      const pasteShortcut =
        (event.ctrlKey && event.shiftKey && event.code === 'KeyV') || (event.shiftKey && event.code === 'Insert')
      if (pasteShortcut) {
        const clipboardText = window.shellApi.readClipboardText()
        if (clipboardText && incarnationRef.current) {
          window.terminalApi.write(data.sessionId, incarnationRef.current, clipboardText)
        }
        return false
      }

      return true
    })
    // The frame can still fire after a teardown, and a spawn from a dead attachment would only have
    // to be killed again on arrival - so the handle is cancelled and the callback checks it is current.
    const startFrame = requestAnimationFrame(() => {
      if (!active) return
      fit()
      void window.terminalApi
        .create({
          id,
          sessionId: data.sessionId,
          attachmentId,
          kind: 'terminal',
          cols: terminal.cols,
          rows: terminal.rows,
          cwd: data.workingDirectory,
          initialInput: data.initialInput
        })
        .then((result) => {
          if (!active) {
            if (result.ok && result.incarnationId)
              window.terminalApi.kill(data.sessionId, result.incarnationId, attachmentId)
            return
          }
          if (result.ok && result.incarnationId) {
            const incarnationId = result.incarnationId
            incarnationRef.current = incarnationId
            started = true
            const liveness =
              exitedRef.current && incarnationRef.current === incarnationId ? 'exited' : (result.liveness ?? 'live')
            data.onTerminalLiveness?.(id, liveness)
            data.onStatusChange(id, liveness === 'exited' ? 'exited' : 'idle')
            fit()
            terminal.focus()
          } else {
            data.onTerminalLiveness?.(id, 'unverifiable')
            data.onStatusChange(id, 'exited')
            terminal.write(`\x1b[31;1mCould not start ${labelRef.current}.\x1b[0m\r\n${result.message}\r\n`)
          }
        })
    })

    return () => {
      active = false
      cancelAnimationFrame(startFrame)
      removeDataListener()
      removeExitListener()
      inputSubscription.dispose()
      selectionSubscription.dispose()
      if (incarnationRef.current) window.terminalApi.kill(data.sessionId, incarnationRef.current, attachmentId)
      incarnationRef.current = null
      terminalRef.current = null
      dispose()
    }
    // This effect owns the xterm instance and the PTY attachment: re-running it disposes the
    // terminal and kills the shell. Only the fields naming *which* terminal this is may trigger
    // that. `data` as a whole and the render-fresh `acknowledgeActivity` change on every keystroke
    // the node re-renders for, and are read at call time instead - and so is `data.label`, through
    // `labelRef`, because renaming a node must not respawn its shell.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    data.dormant,
    data.onAttention,
    data.onStatusChange,
    data.onTerminalLiveness,
    data.sessionId,
    data.workingDirectory,
    id
  ])

  return (
    <article
      className={`terminal-node ${selected ? 'selected' : ''}`}
      style={
        {
          '--node-accent': TERMINAL_ACCENT,
          '--project-color': data.projectColor
        } as React.CSSProperties
      }
    >
      <NodeBorderResizer minWidth={360} minHeight={240} selected={selected} color={data.projectColor} />
      {/* The terminal-context edge's source: drag onto a chat node to let its agent read this
          terminal's output. Rendered while dormant too - the retained tail is exactly what an
          agent reads after an exit. */}
      <Handle
        type="source"
        position={Position.Right}
        className="terminal-context-handle"
        title="Drag to a chat node to let its agent read this terminal's output"
      />
      <header className="node-header">
        <span className="status-dot" data-liveness={data.terminalLiveness} />
        <strong>{data.label}</strong>
        <span className="node-project" title={data.projectPath}>
          <span className="project-color-dot" />
          {data.projectName}
        </span>
        <WorktreeBadge data={data} />
        <button
          type="button"
          className="node-action nodrag"
          disabled={data.dormant || !hasSelection}
          title="Select terminal text, then copy it"
          onMouseDown={(event) => event.stopPropagation()}
          onClick={copySelection}
        >
          Copy
        </button>
        <UnreadToggle
          unread={data.unread ?? 0}
          onToggle={(next) => {
            unreadHoldRef.current = next === 'unread'
            if (next === 'unread') data.onAttention?.({ type: 'unread', nodeId: id })
            else markRead()
          }}
        />
        <CanvasTerminalLiveness liveness={data.terminalLiveness} />
        <NodeFitAction nodeId={id} fitted={data.fittedToCanvas ?? false} />
      </header>
      <div
        ref={hostRef}
        className="terminal-host nodrag nopan nowheel"
        onMouseDown={() => {
          acknowledgeActivity()
          hostRef.current?.querySelector<HTMLTextAreaElement>('textarea')?.focus()
        }}
        onContextMenu={(event) => {
          event.preventDefault()
          event.stopPropagation()
          copySelection()
        }}
      >
        {data.dormant && (
          <div className={`dormant-session ${hasRestoredScrollback ? 'dormant-session-with-history' : ''}`}>
            <span className="dormant-session-icon">
              <SessionKindIcon kind="terminal" />
            </span>
            <strong>{data.terminalLiveness === 'exited' ? 'Terminal exited' : 'Terminal liveness unverifiable'}</strong>
            <small>
              {data.terminalLiveness === 'exited'
                ? 'The process owner confirmed that the previous shell exited.'
                : 'Toucan has no authoritative process-owner evidence that this shell exited.'}
            </small>
            {hasRestoredScrollback && (
              <small>Showing retained output from the previous process below. History is display-only.</small>
            )}
            {scrollbackState === 'missing' && (
              <small>Retained output is missing, expired, corrupt, or could not be read.</small>
            )}
            <button
              type="button"
              className="resume-session nodrag"
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation()
                data.onResume(id)
              }}
            >
              Reopen shell
            </button>
          </div>
        )}
      </div>
    </article>
  )
}
