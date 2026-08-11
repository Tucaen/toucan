export type TerminalKind = 'terminal' | 'claude' | 'codex'

export interface TerminalCreateRequest {
  id: string
  kind: TerminalKind
  cols: number
  rows: number
}

export interface TerminalCreateResult {
  ok: boolean
  message?: string
}

export interface TerminalOutput {
  id: string
  data: string
}

export interface TerminalExit {
  id: string
  exitCode: number
}
