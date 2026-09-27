/**
 * How the graph first frames itself on a phone (and a tablet).
 *
 * Fitting the whole graph into a 360px canvas draws it at a quarter of its size, and every
 * node label shrinks to 2–3px: a picture of a graph, not one anybody can read. On a phone the
 * first frame is instead READABLE: never below `PHONE_MIN_ZOOM` (node text at about 11px),
 * framed on the left of the graph, where the work that everything else waits on starts.
 * Pinch and drag reach the rest, and the fit button in the corner still shows the whole thing.
 */
/** Below this the whole-graph fit is replaced by a readable one (phones and tablets). */
export const READABLE_FIT_BELOW = 1024;
export const PHONE_FIT_BELOW = 720;
/** Node labels are 10px; at this zoom a phone draws them at 11px. */
export const PHONE_MIN_ZOOM = 1.1;
/** A tablet sits further from the eye than a phone's 11px needs; 10px is enough there. */
export const TABLET_MIN_ZOOM = 1;
export const DESKTOP_FIT = { padding: 0.15, maxZoom: 1 } as const;

export interface FitNode {
  id: string;
  position: { x: number; y: number };
  parentId?: string;
}

export interface FitOptions {
  padding: number;
  maxZoom: number;
  minZoom?: number;
  nodes?: { id: string }[];
}

/**
 * The fit for a canvas `canvasWidth` px wide. Wide canvases fit everything (unchanged); a
 * phone fits the top-level nodes that start within one screen of the graph's left edge, at
 * a zoom the labels can be read at.
 */
export function initialFit(nodes: readonly FitNode[], viewportWidth: number, canvasWidth: number): FitOptions {
  if (viewportWidth >= READABLE_FIT_BELOW) return { ...DESKTOP_FIT };
  const zoom = viewportWidth < PHONE_FIT_BELOW ? PHONE_MIN_ZOOM : TABLET_MIN_ZOOM;
  const top = nodes.filter((node) => !node.parentId);
  if (top.length === 0) return { ...DESKTOP_FIT, minZoom: zoom, maxZoom: zoom };
  const left = Math.min(...top.map((node) => node.position.x));
  const reach = canvasWidth / zoom;
  const first = top.filter((node) => node.position.x - left < reach * 0.6);
  return {
    padding: 0.05,
    minZoom: zoom,
    maxZoom: zoom,
    nodes: first.map((node) => ({ id: node.id })),
  };
}
