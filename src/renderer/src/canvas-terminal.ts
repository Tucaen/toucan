import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import { correctScaledTerminalPointerCoordinates } from './scaled-pointer-coordinates'

/**
 * One xterm instance on the canvas, however the node is currently living.
 *
 * A terminal node builds a terminal twice over its life - a live one attached to a PTY, and a
 * dormant one that only replays retained scrollback - and the two agreed on everything that
 * matters: the font, the scrollback depth, the theme, the fit addon, the pointer correction React
 * Flow's viewport scale needs, and the order teardown has to happen in. They were written out
 * twice, and the theme colours four times (#230). Only two things ever actually differed, and both
 * are `interactive`: a dormant terminal takes no input and shows no cursor.
 *
 * `fit()` is deliberately forgiving. The canvas can be between layout frames - mid-resize, or
 * before a node has laid out at all - and xterm throws when it cannot measure a cell; that is a
 * frame to skip, not a failure to report. `onFit` runs inside the same guard, because a caller
 * that has to tell a PTY about the new size must not be told about a size that was never applied.
 */

/** The `--terminal` token from `styles.css`. xterm takes colour values, not CSS variables. */
export const TERMINAL_ACCENT = '#74d8a2'

const TERMINAL_BACKGROUND = '#101319'

export interface CanvasTerminalOptions {
  /** A live shell takes keystrokes and blinks a cursor; a dormant node is display-only. */
  interactive: boolean
  /** Runs after each successful fit, before the frame ends. */
  onFit?(terminal: Terminal): void
}

export interface CanvasTerminal {
  terminal: Terminal
  /** Re-measures against the host element, and tells `onFit` only when it worked. */
  fit(): void
  /** Stops observing, releases the pointer correction, and disposes the terminal - in that order. */
  dispose(): void
}

/** Builds a terminal into `host`, already opened, observed for resizes, and fitted once. */
export function createCanvasTerminal(host: HTMLElement, options: CanvasTerminalOptions): CanvasTerminal {
  const terminal = new Terminal({
    cursorBlink: options.interactive,
    cursorStyle: 'bar',
    fontFamily: 'Cascadia Code, CaskaydiaCove Nerd Font, Consolas, monospace',
    fontSize: 15,
    lineHeight: 1.18,
    scrollback: 5000,
    disableStdin: !options.interactive,
    theme: {
      background: TERMINAL_BACKGROUND,
      foreground: '#d9dee8',
      // A dormant terminal hides its cursor by painting it the background colour: there is no
      // process behind it, so a blinking caret would promise a shell that is not there.
      cursor: options.interactive ? TERMINAL_ACCENT : TERMINAL_BACKGROUND,
      selectionBackground: '#394456'
    }
  })
  const fitAddon = new FitAddon()
  terminal.loadAddon(fitAddon)
  terminal.open(host)
  const removePointerCorrection = correctScaledTerminalPointerCoordinates(
    terminal.element,
    terminal.element?.querySelector<HTMLElement>('.xterm-screen')
  )

  const fit = (): void => {
    try {
      fitAddon.fit()
      options.onFit?.(terminal)
    } catch {
      /* The canvas may be between layout frames while a node is being resized. */
    }
  }

  const resizeObserver = new ResizeObserver(fit)
  resizeObserver.observe(host)
  fit()

  return {
    terminal,
    fit,
    dispose: () => {
      resizeObserver.disconnect()
      removePointerCorrection()
      terminal.dispose()
    }
  }
}
