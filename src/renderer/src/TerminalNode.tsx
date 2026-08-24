import { useEffect, useRef, useState } from 'react'
import { type NodeProps } from '@xyflow/react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import type { TerminalCanvasNode } from './canvas-workspace'
import NodeBorderResizer from './NodeBorderResizer'
import { terminalLivenessDescription, terminalLivenessLabels } from './terminal-liveness'

const accents = {
  terminal: '#74d8a2',
  claude: '#e69a71',
  codex: '#71a9ff'
} as const

export default function TerminalNode({ id, data, selected }: NodeProps<TerminalCanvasNode>): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const selectedRef = useRef(selected)
  const exitedRef = useRef(false)
  const incarnationRef = useRef<string | null>(null)
  const attentionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const previewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const conversationIdRef = useRef(data.conversationId)
  const [hasSelection, setHasSelection] = useState(false)
  const canResumeConversation = data.kind !== 'terminal' && Boolean(data.conversationId)
  const previewTime = data.preview && Number.isFinite(Date.parse(data.preview.updatedAt))
    ? new Date(data.preview.updatedAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })
    : null

  selectedRef.current = selected
  conversationIdRef.current = data.conversationId

  const clearAttentionTimer = (): void => {
    if (attentionTimerRef.current) clearTimeout(attentionTimerRef.current)
    attentionTimerRef.current = null
  }

  const refreshPreview = (): void => {
    const conversationId = conversationIdRef.current
    if (data.kind === 'terminal' || !conversationId) return
    void window.terminalApi.getConversationPreview(data.kind, conversationId).then((preview) => {
      if (preview) data.onPreview(id, preview)
    })
  }

  const schedulePreviewRefresh = (): void => {
    if (previewTimerRef.current) clearTimeout(previewTimerRef.current)
    previewTimerRef.current = setTimeout(refreshPreview, 1100)
  }

  const acknowledgeActivity = (): void => {
    clearAttentionTimer()
    if (!data.dormant && !exitedRef.current) data.onStatusChange(id, 'idle')
  }

  const copySelection = (): void => {
    const selection = terminalRef.current?.getSelection()
    if (selection) window.terminalApi.copyText(selection)
  }

  useEffect(() => {
    if (selected && !data.dormant) acknowledgeActivity()
  }, [data.dormant, selected])

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
        cursor: accents[data.kind],
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
      schedulePreviewRefresh()
      clearAttentionTimer()
      if (!selectedRef.current) {
        attentionTimerRef.current = setTimeout(() => {
          if (!selectedRef.current && !exitedRef.current) data.onStatusChange(id, 'attention')
        }, 1200)
      }
    })
    const removeExitListener = window.terminalApi.onExit(data.sessionId, attachmentId, (result) => {
      incarnationRef.current ??= result.incarnationId
      clearAttentionTimer()
      refreshPreview()
      exitedRef.current = true
      data.onTerminalLiveness?.(id, 'exited')
      data.onStatusChange(id, 'exited')
      terminal.write(`\r\n\x1b[90mSession exited with code ${result.exitCode}.\x1b[0m\r\n`)
    })
    const removeSessionListener = window.terminalApi.onSession(data.sessionId, attachmentId, (result) => {
      incarnationRef.current ??= result.incarnationId
      conversationIdRef.current = result.conversationId
      data.onConversationId(id, result.conversationId)
      schedulePreviewRefresh()
    })
    const inputSubscription = terminal.onData((input) => {
      acknowledgeActivity()
      if (incarnationRef.current) window.terminalApi.write(data.sessionId, incarnationRef.current, input)
    })
    const selectionSubscription = terminal.onSelectionChange(() => setHasSelection(terminal.hasSelection()))
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown') return true

      const copyShortcut = (event.ctrlKey && event.shiftKey && event.code === 'KeyC')
        || (event.ctrlKey && event.code === 'Insert')
      if (copyShortcut) {
        if (terminal.hasSelection()) window.terminalApi.copyText(terminal.getSelection())
        return false
      }

      const pasteShortcut = (event.ctrlKey && event.shiftKey && event.code === 'KeyV')
        || (event.shiftKey && event.code === 'Insert')
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
          kind: data.kind,
          cols: terminal.cols,
          rows: terminal.rows,
          cwd: data.projectPath,
          conversationId: data.conversationId,
          resume: data.launchMode === 'resume'
        })
        .then((result) => {
          if (!active) {
            if (result.ok && result.incarnationId) window.terminalApi.kill(data.sessionId, result.incarnationId, attachmentId)
            return
          }
          if (result.ok && result.incarnationId) {
            const incarnationId = result.incarnationId
            incarnationRef.current = incarnationId
            started = true
            const liveness = result.liveness ?? 'live'
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
      if (previewTimerRef.current) clearTimeout(previewTimerRef.current)
      resizeObserver.disconnect()
      removeDataListener()
      removeExitListener()
      removeSessionListener()
      inputSubscription.dispose()
      selectionSubscription.dispose()
      if (incarnationRef.current) window.terminalApi.kill(data.sessionId, incarnationRef.current, attachmentId)
      incarnationRef.current = null
      terminalRef.current = null
      terminal.dispose()
    }
  }, [data.dormant, data.kind, data.label, data.launchMode, data.onStatusChange, data.onTerminalLiveness, data.projectPath, data.sessionId, id])

  return (
    <article
      className={`terminal-node ${selected ? 'selected' : ''}`}
      style={{
        '--node-accent': accents[data.kind],
        '--project-color': data.projectColor
      } as React.CSSProperties}
    >
      <NodeBorderResizer minWidth={360} minHeight={240} selected={selected} color={data.projectColor} />
      <header className="node-header">
        <span className="status-dot" data-liveness={data.terminalLiveness} />
        <strong>{data.label}</strong>
        <span className="node-project" title={data.projectPath}>
          <span className="project-color-dot" />
          {data.projectName}
        </span>
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
        <span
          className="node-status"
          data-liveness={data.terminalLiveness}
          title={data.kind === 'terminal' ? terminalLivenessDescription(data.terminalLiveness) : undefined}
        >
          {data.kind === 'terminal' ? terminalLivenessLabels[data.terminalLiveness].toUpperCase() : data.dormant ? 'SAVED' : 'LOCAL'}
        </span>
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
          <div className="dormant-session">
            <span className="dormant-session-icon">{data.kind === 'terminal' ? '>_' : data.kind === 'claude' ? 'C' : '<>'}</span>
            <strong>{data.kind === 'terminal'
              ? data.terminalLiveness === 'exited' ? 'Terminal exited' : 'Terminal liveness unverifiable'
              : 'Saved conversation'}</strong>
            <small>
              {data.kind === 'terminal'
                ? data.terminalLiveness === 'exited'
                  ? 'The process owner confirmed that the previous shell exited.'
                  : 'ADE has no authoritative process-owner evidence that this shell exited.'
                : canResumeConversation
                  ? 'The previous CLI process ended, but its conversation can continue.'
                  : 'ADE could not link this node to a saved conversation.'}
            </small>
            {data.preview && (data.preview.user || data.preview.assistant) && (
              <div className="conversation-preview">
                {data.preview.user && (
                  <div>
                    <span>You</span>
                    <p>{data.preview.user}</p>
                  </div>
                )}
                {data.preview.assistant && (
                  <div>
                    <span>{data.kind === 'claude' ? 'Claude' : 'Codex'}</span>
                    <p>{data.preview.assistant}</p>
                  </div>
                )}
                {previewTime && <time dateTime={data.preview.updatedAt}>Updated {previewTime}</time>}
              </div>
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
              {data.kind === 'terminal'
                ? 'Reopen shell'
                : canResumeConversation
                  ? 'Resume conversation'
                  : 'Start new conversation'}
            </button>
          </div>
        )}
      </div>
    </article>
  )
}
