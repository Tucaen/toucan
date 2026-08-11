import { useEffect, useRef } from 'react'
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
    const resizeObserver = new ResizeObserver(fit)
    resizeObserver.observe(hostRef.current)

    requestAnimationFrame(() => {
      fit()
      void window.terminalApi
        .create({ id, kind: data.kind, cols: terminal.cols, rows: terminal.rows })
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
      window.terminalApi.kill(id)
      terminal.dispose()
    }
  }, [data.kind, data.label, id])

  return (
    <article
      className={`terminal-node ${selected ? 'selected' : ''}`}
      style={{ '--node-accent': accents[data.kind] } as React.CSSProperties}
    >
      <NodeResizer minWidth={360} minHeight={240} isVisible={selected} color={accents[data.kind]} />
      <header className="node-header">
        <span className="status-dot" />
        <strong>{data.label}</strong>
        <span className="node-status">LOCAL</span>
      </header>
      <div
        ref={hostRef}
        className="terminal-host nodrag nopan nowheel"
        onMouseDown={() => hostRef.current?.querySelector<HTMLTextAreaElement>('textarea')?.focus()}
      />
    </article>
  )
}
