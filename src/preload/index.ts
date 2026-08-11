import { clipboard, contextBridge, ipcRenderer } from 'electron'
import type {
  TerminalCreateRequest,
  TerminalCreateResult,
  TerminalExit,
  TerminalOutput
} from '../shared/terminal'

const terminalApi = {
  create: (request: TerminalCreateRequest): Promise<TerminalCreateResult> =>
    ipcRenderer.invoke('terminal:create', request),
  write: (id: string, data: string): void => ipcRenderer.send('terminal:write', id, data),
  resize: (id: string, cols: number, rows: number): void =>
    ipcRenderer.send('terminal:resize', id, cols, rows),
  kill: (id: string): void => ipcRenderer.send('terminal:kill', id),
  copyText: (text: string): void => clipboard.writeText(text),
  readClipboardText: (): string => clipboard.readText(),
  onData: (id: string, callback: (data: string) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, output: TerminalOutput): void => {
      if (output.id === id) callback(output.data)
    }
    ipcRenderer.on('terminal:data', listener)
    return () => ipcRenderer.removeListener('terminal:data', listener)
  },
  onExit: (id: string, callback: (exitCode: number) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, result: TerminalExit): void => {
      if (result.id === id) callback(result.exitCode)
    }
    ipcRenderer.on('terminal:exit', listener)
    return () => ipcRenderer.removeListener('terminal:exit', listener)
  }
}

contextBridge.exposeInMainWorld('terminalApi', terminalApi)
