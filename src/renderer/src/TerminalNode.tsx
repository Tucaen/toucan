import { useEffect, useRef, useState } from 'react'
import { NodeResizer, type NodeProps } from '@xyflow/react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import type { TerminalCanvasNode } from './App'

const accents = {
  terminal: '#74d8a2',
  claude: '#e69a71',
  codex: '#71a9ff'
} as const

export default function TerminalNode({ id, data, selected }: NodeProps<TerminalCanvasNode>): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const [hasSelection, setHasSelection] = useState(false)

  const copySelection = (): void => {
    const selection = terminalRef.current?.getSelection()
    if (selection) window.terminalApi.copyText(selection)
  }

  useEffect(() => {
    if (!hostRef.current) return

    let active = true
    let started = false
    const terminal = new Terminal({
      cursorBlink: true,
      cursorStyle: 'bar',
      fontFamily: 'Cascadia Code, CaskaydiaCove Nerd Font, Consolas, monospace',
      fontSize: 13,
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
        if (started) window.terminalApi.resize(id, terminal.cols, terminal.rows)
      } catch {
        // The canvas may be between layout frames while a node is being resized.
      }
    }

    const removeDataListener = window.terminalApi.onData(id, (output) => terminal.write(output))
    const removeExitListener = window.terminalApi.onExit(id, (exitCode) => {
      terminal.write(`\r\n\x1b[90mSession exited with code ${exitCode}.\x1b[0m\r\n`)
    })
    const inputSubscription = terminal.onData((input) => window.terminalApi.write(id, input))
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
        if (clipboardText) window.terminalApi.write(id, clipboardText)
        return false
      }

      return true
    })
    const resizeObserver = new ResizeObserver(fit)
    resizeObserver.observe(hostRef.current)

    requestAnimationFrame(() => {
      fit()
      void window.terminalApi
        .create({ id, kind: data.kind, cols: terminal.cols, rows: terminal.rows, cwd: data.projectPath })
        .then((result) => {
          if (!active) {
            if (result.ok) window.terminalApi.kill(id)
            return
          }
          if (result.ok) {
            started = true
            fit()
            terminal.focus()
          } else {
            terminal.write(`\x1b[31;1mCould not start ${data.label}.\x1b[0m\r\n${result.message}\r\n`)
          }
        })
    })

    return () => {
      active = false
      resizeObserver.disconnect()
      removeDataListener()
      removeExitListener()
      inputSubscription.dispose()
      selectionSubscription.dispose()
      window.terminalApi.kill(id)
      terminalRef.current = null
      terminal.dispose()
    }
  }, [data.kind, data.label, data.projectPath, id])

  return (
    <article
      className={`terminal-node ${selected ? 'selected' : ''}`}
      style={{
        '--node-accent': accents[data.kind],
        '--project-color': data.projectColor
      } as React.CSSProperties}
    >
      <NodeResizer minWidth={360} minHeight={240} isVisible={selected} color={accents[data.kind]} />
      <header className="node-header">
        <span className="status-dot" />
        <strong>{data.label}</strong>
        <span className="node-project" title={data.projectPath}>
          <span className="project-color-dot" />
          {data.projectName}
        </span>
        <button
          type="button"
          className="node-action nodrag"
          disabled={!hasSelection}
          title="Select terminal text, then copy it"
          onMouseDown={(event) => event.stopPropagation()}
          onClick={copySelection}
        >
          Copy
        </button>
        <span className="node-status">LOCAL</span>
      </header>
      <div
        ref={hostRef}
        className="terminal-host nodrag nopan nowheel"
        onMouseDown={() => hostRef.current?.querySelector<HTMLTextAreaElement>('textarea')?.focus()}
        onContextMenu={(event) => {
          event.preventDefault()
          event.stopPropagation()
          copySelection()
        }}
      />
    </article>
  )
}
