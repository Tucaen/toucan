export interface AgentPermissionToolCall {
  title?: string | null
  name?: string | null
  kind?: string | null
  status?: string | null
  rawInput?: unknown
  locations?: Array<{ path: string }> | null
}

const GENERIC_PERMISSION_TITLE = /^permissions?(?:\s+(?:request|required|requested))?$/i
const TITLE_LIMIT = 240

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function concise(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (!normalized) return undefined
  return normalized.length <= TITLE_LIMIT ? normalized : `${normalized.slice(0, TITLE_LIMIT - 1)}…`
}

function inputText(input: Record<string, unknown> | undefined, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const found = concise(input?.[key])
    if (found) return found
  }
  return undefined
}

/** Builds the specific text ADE shows for an ACP permission request using protocol-owned fields. */
export function agentPermissionTitle(toolCall: AgentPermissionToolCall): string {
  const suppliedTitle = concise(toolCall.title)
  if (suppliedTitle && !GENERIC_PERMISSION_TITLE.test(suppliedTitle)) return suppliedTitle

  const input = record(toolCall.rawInput)
  const location = concise(toolCall.locations?.[0]?.path)
  const file = location ?? inputText(input, 'file_path', 'path')

  switch (toolCall.kind) {
    case 'execute': {
      const command = inputText(input, 'command')
      return command ? `Run command: ${command}` : 'Run a command'
    }
    case 'edit':
      return file ? `Change file: ${file}` : 'Change files'
    case 'delete':
      return file ? `Delete file: ${file}` : 'Delete files'
    case 'move':
      return file ? `Move file: ${file}` : 'Move files'
    case 'read':
      return file ? `Read file: ${file}` : 'Read files'
    case 'search': {
      const query = inputText(input, 'query', 'pattern')
      return query ? `Search for: ${query}` : 'Search project files'
    }
    case 'fetch': {
      const url = inputText(input, 'url')
      return url ? `Access URL: ${url}` : 'Access the network'
    }
    case 'switch_mode':
      return 'Change conversation mode'
    case 'think':
      return 'Use extended reasoning'
    default: {
      const reason = inputText(input, 'reason')
      if (reason) return reason
      const name = concise(toolCall.name)
      return name ? `Use tool: ${name}` : 'Grant additional permissions'
    }
  }
}
