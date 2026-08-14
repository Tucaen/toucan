import {
  FIRSTMATE_PANEL_MAX_WIDTH,
  FIRSTMATE_PANEL_MIN_WIDTH
} from '../../shared/firstmate'

export { FIRSTMATE_PANEL_MAX_WIDTH, FIRSTMATE_PANEL_MIN_WIDTH }
export const FIRSTMATE_CANVAS_MIN_WIDTH = 320
export const FIRSTMATE_PANEL_RESIZE_STEP = 16

export interface FirstMatePanelWidthBounds {
  min: number
  max: number
}

export interface FirstMatePanelResizeSession {
  startX: number
  startWidth: number
  bounds: FirstMatePanelWidthBounds
}

export function firstMatePanelWidthBounds(workspaceWidth: number): FirstMatePanelWidthBounds {
  const usableWidth = Number.isFinite(workspaceWidth) ? workspaceWidth : FIRSTMATE_PANEL_MAX_WIDTH + FIRSTMATE_CANVAS_MIN_WIDTH
  return {
    min: FIRSTMATE_PANEL_MIN_WIDTH,
    max: Math.max(
      FIRSTMATE_PANEL_MIN_WIDTH,
      Math.min(FIRSTMATE_PANEL_MAX_WIDTH, usableWidth - FIRSTMATE_CANVAS_MIN_WIDTH)
    )
  }
}

export function clampFirstMatePanelWidth(width: number, bounds: FirstMatePanelWidthBounds): number {
  return Math.min(bounds.max, Math.max(bounds.min, width))
}

export function resizeFirstMatePanel(session: FirstMatePanelResizeSession, clientX: number): number {
  return clampFirstMatePanelWidth(
    session.startWidth + session.startX - clientX,
    session.bounds
  )
}

export function resizeFirstMatePanelWithKey(
  width: number,
  key: string,
  bounds: FirstMatePanelWidthBounds
): number | undefined {
  if (key === 'Home') return bounds.min
  if (key === 'End') return bounds.max
  if (key === 'ArrowLeft') return clampFirstMatePanelWidth(width + FIRSTMATE_PANEL_RESIZE_STEP, bounds)
  if (key === 'ArrowRight') return clampFirstMatePanelWidth(width - FIRSTMATE_PANEL_RESIZE_STEP, bounds)
  return undefined
}
