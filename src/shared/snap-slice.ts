/** Which part of its canvas an Alt+Arrow snap or a maximise put a node in; the same shape as the renderer's `SnapSlice`. */
export interface WorkspaceSnapSlice {
  h: 'full' | 'left' | 'right'
  v: 'full' | 'top' | 'bottom'
}

export function isWorkspaceSnapSlice(value: unknown): value is WorkspaceSnapSlice {
  if (!value || typeof value !== 'object') return false
  const { h, v } = value as Partial<WorkspaceSnapSlice>
  return (h === 'full' || h === 'left' || h === 'right') && (v === 'full' || v === 'top' || v === 'bottom')
}
