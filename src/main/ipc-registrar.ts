/**
 * The slice of Electron's `ipcMain` a feature's `register*Ipc` module needs: one `handle` per
 * invoke channel, and - for features the renderer also fires `ipcRenderer.send` at - one `on`.
 * Declared here rather than imported from Electron so those modules, and their tests, never load
 * Electron at all. `Sender` is whatever the feature reads off `event.sender` - the window to
 * subscribe, or nothing. `ipcMain` satisfies both shapes structurally; a `register*Ipc` call
 * site passes it bare, never through a cast.
 */
export interface IpcRegistrar<Sender = unknown> {
  handle(channel: string, listener: (event: { sender: Sender }, ...args: unknown[]) => unknown): void
}

/** `IpcRegistrar` plus the fire-and-forget channels the renderer reaches with `ipcRenderer.send`. */
export interface IpcEventRegistrar<Sender = unknown> extends IpcRegistrar<Sender> {
  on(channel: string, listener: (event: { sender: Sender }, ...args: unknown[]) => void): void
}
