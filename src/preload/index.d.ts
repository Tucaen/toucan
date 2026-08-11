import type { TerminalCreateRequest, TerminalCreateResult } from '../shared/terminal'

export interface TerminalApi {
  create(request: TerminalCreateRequest): Promise<TerminalCreateResult>
  write(id: string, data: string): void
  resize(id: string, cols: number, rows: number): void
  kill(id: string): void
  onData(id: string, callback: (data: string) => void): () => void
  onExit(id: string, callback: (exitCode: number) => void): () => void
}

declare global {
  interface Window {
    terminalApi: TerminalApi
  }
}
