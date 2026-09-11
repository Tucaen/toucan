/**
 * xterm draws into a canvas jsdom does not have, so every test that mounts a real `TerminalNode`
 * has to replace it. One stub rather than a copy per file: the three that needed it had drifted
 * into three slightly different classes, and a `TerminalNode` that starts calling a new xterm
 * method should break in one place, not in however many files happen to have kept up.
 *
 * `vi.mock` factories are hoisted above imports, so they cannot close over a static import. Wire
 * it up with a dynamic one instead:
 *
 *   vi.mock('@xterm/xterm', async () => (await import('./dom/xterm-mock')).xtermModule())
 *   vi.mock('@xterm/addon-fit', async () => (await import('./dom/xterm-mock')).fitAddonModule())
 *
 * Both resolve to this same module instance, so a test can import `terminalWrites` normally and
 * read what the component under test wrote.
 */

/** Everything written to the terminal, newest last. */
export const terminalWrites: string[] = []

/** Whoever registered for keystrokes, so a test can play the user typing. */
export const terminalInputs: Array<(data: string) => void> = []

/** Call from `beforeEach`; the arrays are module state and outlive a single test otherwise. */
export function resetXtermMock(): void {
  terminalWrites.length = 0
  terminalInputs.length = 0
}

export function xtermModule(): { Terminal: new () => unknown } {
  return {
    Terminal: class {
      cols = 80
      rows = 24
      loadAddon(): void {}
      open(): void {}
      focus(): void {}
      write(data: string): void {
        terminalWrites.push(data)
      }
      onData(listener: (data: string) => void): { dispose(): void } {
        terminalInputs.push(listener)
        return { dispose: () => undefined }
      }
      onSelectionChange(): { dispose(): void } {
        return { dispose: () => undefined }
      }
      attachCustomKeyEventHandler(): void {}
      hasSelection(): boolean {
        return false
      }
      getSelection(): string {
        return ''
      }
      dispose(): void {}
    }
  }
}

export function fitAddonModule(): { FitAddon: new () => unknown } {
  return {
    FitAddon: class {
      fit(): void {}
    }
  }
}
