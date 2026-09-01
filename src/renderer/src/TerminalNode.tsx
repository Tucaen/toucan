import { useEffect, useRef, useState } from 'react'
import { type NodeProps } from '@xyflow/react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import type { TerminalCanvasNode } from './canvas-workspace'
import { READ_ON_VIEW_KINDS } from '../../shared/attention'
import NodeBorderResizer from './NodeBorderResizer'
import SessionKindIcon from './SessionKindIcon'
import UnreadToggle from './UnreadToggle'
import { CanvasTerminalLiveness } from './TerminalLivenessPresentation'
import WorktreeBadge from './WorktreeBadge'

export default function TerminalNode({ id, data, selected }: NodeProps<TerminalCanvasNode>): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const selectedRef = useRef(selected)
  const exitedRef = useRef(false)
  const incarnationRef = useRef<string | null>(null)
  const attentionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /**
   * Which burst of output the current attention record belongs to. Output is a condition that
   * genuinely recurs, and an already-read record is never resurrected (see shared/attention.ts),
   * so acknowledging the terminal opens the next burst under a new key. Everything written in
   * between - however much of it - folds into that one record.
   */
  const outputBurstRef = useRef(0)
  const unreadHoldRef = useRef(false)
  const [hasSelection, setHasSelection] = useState(false)
  const [scrollbackState, setScrollbackState] = useState<'loading' | 'available' | 'missing'>('loading')
  const hasRestoredScrollback = scrollbackState === 'available'

  selectedRef.current = selected

  const clearAttentionTimer = (): void => {
    if (attentionTimerRef.current) clearTimeout(attentionTimerRef.current)
    attentionTimerRef.current = null
  }

  /**
   * Every path that reads this terminal has to go through here. The burst counter is what lets
   * later output raise attention again (a read record is never resurrected under the same key),
   * so a read that skipped it would silence the terminal for the rest of the incarnation.
   */
  const markRead = (): void => {
    outputBurstRef.current += 1
    data.onAttention?.({ type: 'read', nodeId: id, kinds: READ_ON_VIEW_KINDS })
  }

  const acknowledgeActivity = (): void => {
    clearAttentionTimer()
    if (!unreadHoldRef.current) markRead()
    if (!data.dormant && !exitedRef.current) data.onStatusChange(id, 'idle')
  }

  const copySelection = (): void => {
    const selection = terminalRef.current?.getSelection()
    if (selection) window.terminalApi.copyText(selection)
  }

  useEffect(() => {
    if (!selected) unreadHoldRef.current = false
    if (selected && !data.dormant) acknowledgeActivity()
  }, [data.dormant, selected])

  useEffect(() => {
    if (!data.dormant || !hostRef.current) return

    let active = true
    setScrollbackState('loading')
    const terminal = new Terminal({
      cursorBlink: false,
      cursorStyle: 'bar',
      fontFamily: 'Cascadia Code, CaskaydiaCove Nerd Font, Consolas, monospace',
      fontSize: 15,
      lineHeight: 1.18,
      scrollback: 5000,
      disableStdin: true,
      theme: {
        background: '#101319',
        foreground: '#d9dee8',
        cursor: '#101319',
        selectionBackground: '#394456'
      }
    })
    terminalRef.current = terminal
    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)
    terminal.open(hostRef.current)
    const resizeObserver = new ResizeObserver(() => {
      try {
        fitAddon.fit()
      } catch {
        /* The canvas may be between layout frames. */
      }
    })
    resizeObserver.observe(hostRef.current)
    try {
      fitAddon.fit()
    } catch {
      /* The node may not have completed layout. */
    }

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
      resizeObserver.disconnect()
      terminalRef.current = null
      terminal.dispose()
    }
  }, [data.dormant, data.sessionId])

  useEffect(() => {
    if (data.dormant || !hostRef.current) return

    let active = true
    let started = false
    const attachmentId = crypto.randomUUID()
    const terminal = new Terminal({
      cursorBlink: true,
      cursorStyle: 'bar',
      fontFamily: 'Cascadia Code, CaskaydiaCove Nerd Font, Consolas, monospace',
      fontSize: 15,
      lineHeight: 1.18,
      scrollback: 5000,
      theme: {
        background: '#101319',
        foreground: '#d9dee8',
        cursor: '#74d8a2',
        selectionBackground: '#394456'
      }
    })
    terminalRef.current = terminal
    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)
    terminal.open(hostRef.current)

    const fit = (): void => {
      try {
        fitAddon.fit()
        if (started && incarnationRef.current) {
          window.terminalApi.resize(data.sessionId, incarnationRef.current, terminal.cols, terminal.rows)
        }
      } catch {
        // The canvas may be between layout frames while a node is being resized.
      }
    }

    exitedRef.current = false
    const removeDataListener = window.terminalApi.onData(data.sessionId, attachmentId, (output) => {
      incarnationRef.current ??= output.incarnationId
      terminal.write(output.data)
      clearAttentionTimer()
      if (!selectedRef.current) {
        // The debounce keeps a chatty command from raising anything until it pauses; the burst
        // key then keeps everything after that pause inside one record.
        attentionTimerRef.current = setTimeout(() => {
          if (selectedRef.current || exitedRef.current) return
          data.onStatusChange(id, 'attention')
          data.onAttention?.({
            type: 'raise',
            signal: {
              nodeId: id,
              kind: 'output',
              key: `${output.incarnationId}:${outputBurstRef.current}`,
              sourceId: data.sessionId,
              summary: `${data.label} has new output`
            }
          })
        }, 1200)
      }
    })
    const removeExitListener = window.terminalApi.onExit(data.sessionId, attachmentId, (result) => {
      incarnationRef.current ??= result.incarnationId
      clearAttentionTimer()
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
            summary: `${data.label} exited with code ${result.exitCode}`
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
        if (terminal.hasSelection()) window.terminalApi.copyText(terminal.getSelection())
        return false
      }

      const pasteShortcut =
        (event.ctrlKey && event.shiftKey && event.code === 'KeyV') || (event.shiftKey && event.code === 'Insert')
      if (pasteShortcut) {
        const clipboardText = window.terminalApi.readClipboardText()
        if (clipboardText && incarnationRef.current) {
          window.terminalApi.write(data.sessionId, incarnationRef.current, clipboardText)
        }
        return false
      }

      return true
    })
    const resizeObserver = new ResizeObserver(fit)
    resizeObserver.observe(hostRef.current)

    requestAnimationFrame(() => {
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
            terminal.write(`\x1b[31;1mCould not start ${data.label}.\x1b[0m\r\n${result.message}\r\n`)
          }
        })
    })

    return () => {
      active = false
      clearAttentionTimer()
      resizeObserver.disconnect()
      removeDataListener()
      removeExitListener()
      inputSubscription.dispose()
      selectionSubscription.dispose()
      if (incarnationRef.current) window.terminalApi.kill(data.sessionId, incarnationRef.current, attachmentId)
      incarnationRef.current = null
      terminalRef.current = null
      terminal.dispose()
    }
  }, [
    data.dormant,
    data.label,
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
          '--node-accent': '#74d8a2',
          '--project-color': data.projectColor
        } as React.CSSProperties
      }
    >
      <NodeBorderResizer minWidth={360} minHeight={240} selected={selected} color={data.projectColor} />
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
