import type { JSX } from 'react'
import type { McpToolCall } from './mcp-tool-call'

/**
 * Server and tool stay visually separate. Rendering `linear.create_issue` as one string is what
 * lets a third-party tool pass for a built-in; the server chip is the part that says whose code
 * is about to run.
 */
export function McpToolCallSummary({ call }: { call: McpToolCall }): JSX.Element {
  return (
    <span className="mcp-summary">
      <span className="mcp-server">{call.server}</span>
      <span className="mcp-tool">{call.tool}</span>
      <span className="external-source-badge">MCP</span>
    </span>
  )
}

export function McpToolCallBody({ call, args, result }: {
  call: McpToolCall
  args: string[]
  result: string[]
}): JSX.Element {
  return (
    <div className="mcp-body">
      <small className="mcp-origin">Provided by the {call.server} MCP server</small>
      {args.length > 0 && <pre className="mcp-arguments">{args.join('\n')}</pre>}
      {result.length > 0 && <pre className="mcp-result">{result.join('\n')}</pre>}
    </div>
  )
}
