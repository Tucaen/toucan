/**
 * The slice of Electron's `ipcMain` a feature's `register*Ipc` module needs: one `handle` per
 * channel. Declared here rather than imported from Electron so those modules, and their tests,
 * never load Electron at all. `Sender` is whatever the feature reads off `event.sender` - the
 * window to subscribe, or nothing.
 */
export interface IpcRegistrar<Sender = unknown> {
  handle(channel: string, listener: (event: { sender: Sender }, ...args: unknown[]) => unknown): void
}
