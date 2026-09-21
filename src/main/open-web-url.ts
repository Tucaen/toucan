/** The only policy for handing an external URL to the operating system. */
export async function openWebUrl(
  value: unknown,
  openExternal: (url: string) => Promise<unknown>
): Promise<boolean> {
  if (typeof value !== 'string') return false
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  await openExternal(url.toString())
  return true
}
