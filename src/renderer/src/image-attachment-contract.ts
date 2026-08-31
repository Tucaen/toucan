export interface AgentImageAttachment {
  id: string
  /** Base64-encoded image bytes, without the `data:` URL prefix. */
  data: string
  mimeType: string
}
